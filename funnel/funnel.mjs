// STMA Bot · entonnoir de traders memecoins Solana (argent fictif, données publiques uniquement, aucun secret).
// Sources gratuites : GeckoTerminal (pools tendance / nouveaux / plus actifs + 300 derniers trades par pool),
// DexScreener (jetons boostés → pools), Kolscan (classement KOL 1 j / 7 j / 30 j avec PnL).
// Chaque exécution (GitHub Action, toutes les heures) ajoute les nouveaux trades à un état glissant de 3 jours,
// note chaque portefeuille (PnL réalisé, ROI, taux de gain, durée de détention, robots exclus) et publie
// short.json (300 meilleurs éligibles) que le Worker lit pour choisir les portefeuilles à suivre.
import fs from 'node:fs'; import zlib from 'node:zlib';
const DIR = process.argv[2] || 'data', NOW = Date.now(), H = 3600000, KEEP = 3 * 24 * H;
const BUDGET_MS = (+process.env.FUNNEL_MINUTES || 9) * 60000, GT_GAP = +process.env.GT_GAP_MS || 6500;
const WSOL = 'So11111111111111111111111111111111111111112';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(DIR, { recursive: true });
let S = { v: 1, pools: {}, wp: {}, runs: [] };
try { S = JSON.parse(zlib.gunzipSync(fs.readFileSync(DIR + '/state.json.gz'))); } catch (e) { console.log('nouvel état'); }
const stat = { gtCalls: 0, gt429: 0, pools: 0, trades: 0, newTrades: 0, dsTokens: 0, kol: 0 };
let lastGt = 0;
async function gt(path) {
  for (let a = 0; a < 4; a++) {
    const wait = lastGt + GT_GAP - Date.now(); if (wait > 0) await sleep(wait); lastGt = Date.now();
    stat.gtCalls++;
    try { const r = await fetch('https://api.geckoterminal.com/api/v2' + path, { headers: { accept: 'application/json' } });
      if (r.status === 429) { stat.gt429++; await sleep(30000); continue; }
      if (!r.ok) return null; return await r.json(); } catch (e) { await sleep(3000); }
  }
  return null;
}
async function js(url) { try { const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (STMA Bot funnel)', accept: 'application/json,text/html' } }); return r.ok ? await r.text() : null; } catch (e) { return null; } }

// 1) liste des pools Solana à scruter
const pools = new Map();   // adresse → { fdv, liq, src }
const addPool = (a, fdv, liq, src) => { if (!a || pools.has(a)) return; if (fdv > 0 && fdv < 5000) return; pools.set(a, { fdv, liq, src }); };
for (const [path, src, pages] of [['/networks/solana/trending_pools?duration=1h', 'gt-trend1h', 3], ['/networks/solana/trending_pools?duration=24h', 'gt-trend24h', 3], ['/networks/solana/new_pools', 'gt-new', 3], ['/networks/solana/pools?sort=h24_tx_count_desc', 'gt-top', 3]]) {
  for (let p = 1; p <= pages; p++) { const j = await gt(path + (path.includes('?') ? '&' : '?') + 'page=' + p); if (!j || !j.data) break;
    for (const x of j.data) addPool(x.attributes.address, +x.attributes.fdv_usd || 0, +x.attributes.reserve_in_usd || 0, src); }
}
// DexScreener : jetons boostés / profils récents → meilleure paire Solana
const dsTok = new Set();
for (const u of ['https://api.dexscreener.com/token-boosts/top/v1', 'https://api.dexscreener.com/token-boosts/latest/v1', 'https://api.dexscreener.com/token-profiles/latest/v1']) {
  const t = await js(u); if (!t) continue; try { for (const x of JSON.parse(t)) if (x.chainId === 'solana' && x.tokenAddress) dsTok.add(x.tokenAddress); } catch (e) {}
}
const dsList = [...dsTok]; stat.dsTokens = dsList.length;
for (let i = 0; i < dsList.length; i += 30) {
  const t = await js('https://api.dexscreener.com/tokens/v1/solana/' + dsList.slice(i, i + 30).join(',')); if (!t) continue;
  try { const best = {}; for (const p of JSON.parse(t)) { const k = p.baseToken && p.baseToken.address; if (!k) continue; if (!best[k] || (p.liquidity && p.liquidity.usd || 0) > (best[k].liquidity && best[k].liquidity.usd || 0)) best[k] = p; }
    for (const p of Object.values(best)) addPool(p.pairAddress, p.fdv || p.marketCap || 0, p.liquidity && p.liquidity.usd || 0, 'dexscreener'); } catch (e) {}
}
// les pools déjà connus encore actifs restent dans la rotation
for (const [a, p] of Object.entries(S.pools)) if (NOW - p.seen < 24 * H) addPool(a, p.fdv || 0, 0, 'suivi');
stat.pools = pools.size;

// 2) trades récents par pool (les pools les moins récemment lus d'abord), dans le temps imparti
let solUsd = 0;
const order = [...pools.keys()].sort((a, b) => ((S.pools[a] && S.pools[a].read) || 0) - ((S.pools[b] && S.pools[b].read) || 0));
const t0 = Date.now(); let read = 0;
for (const a of order) {
  if (Date.now() - t0 > BUDGET_MS) break;
  const j = await gt('/networks/solana/pools/' + a + '/trades'); if (!j || !j.data) continue; read++;
  const P = S.pools[a] || (S.pools[a] = { ts: 0, seen: NOW, read: 0, fdv: pools.get(a).fdv });
  P.read = NOW; P.fdv = pools.get(a).fdv || P.fdv;
  let maxTs = P.ts; const blocks = {};
  for (const x of j.data) {
    const t = x.attributes; stat.trades++;
    const ts = Date.parse(t.block_timestamp); if (!(ts > P.ts) || t.is_anomalous) continue;
    stat.newTrades++; maxTs = Math.max(maxTs, ts); P.seen = NOW;
    const buy = t.kind === 'buy', w = t.tx_from_address, usd = +t.volume_in_usd || 0;
    const tok = buy ? +t.to_token_amount : +t.from_token_amount;
    if (!solUsd) { if (t.to_token_address === WSOL) solUsd = +t.price_to_in_usd; else if (t.from_token_address === WSOL) solUsd = +t.price_from_in_usd; }
    const k = w + '|' + a, e = S.wp[k] || (S.wp[k] = [0, 0, 0, 0, ts, ts, 0, 0, 0]);   // [tokAchetés, $achat, tokVendus, $vente, t1er, tDernier, nAchats, nVentes, mêmeBloc]
    if (buy) { e[0] += tok; e[1] += usd; e[6]++; } else { e[2] += tok; e[3] += usd; e[7]++; }
    e[4] = Math.min(e[4], ts); e[5] = Math.max(e[5], ts);
    const bk = w + t.block_number; blocks[bk] = (blocks[bk] || 0) | (buy ? 1 : 2); if (blocks[bk] === 3) e[8]++;   // achat + vente dans le même bloc : robot / MEV
  }
  P.ts = maxTs;
}
// ménage : 3 jours glissants
for (const k in S.wp) if (NOW - S.wp[k][5] > KEEP) delete S.wp[k];
for (const a in S.pools) if (NOW - S.pools[a].seen > KEEP) delete S.pools[a];

// 3) Kolscan (PnL officiel du classement, 1 j / 7 j / 30 j)
const kol = {};
const kh = await js('https://kolscan.io/leaderboard');
if (kh) { const re = /\\"wallet_address\\":\\"([1-9A-HJ-NP-Za-km-z]{32,44})\\",\\"name\\":\\"((?:[^"\\]|\\\\.)*)\\"[^{}]*?\\"profit\\":(-?[\d.e+-]+),\\"wins\\":(\d+),\\"losses\\":(\d+),\\"timeframe\\":(\d+)/g; let m;
  while ((m = re.exec(kh))) { const o = kol[m[1]] || (kol[m[1]] = { n: m[2].slice(0, 24) }); o['p' + m[6]] = +m[3]; o['w' + m[6]] = +m[4]; o['l' + m[6]] = +m[5]; } }
stat.kol = Object.keys(kol).length;

// 4) note de chaque portefeuille vu
const W = {};
for (const [k, e] of Object.entries(S.wp)) {
  const w = k.slice(0, k.indexOf('|')); const o = W[w] || (W[w] = { pnl: 0, inv: 0, rt: 0, win: 0, n: 0, pools: 0, mev: 0, holds: [], buy: 0, t1: 0, t0: Infinity });
  o.n += e[6] + e[7]; o.pools++; o.mev += e[8]; o.buy += e[1]; o.t1 = Math.max(o.t1, e[5]); o.t0 = Math.min(o.t0, e[4]);
  if (e[0] > 0 && e[2] > 0) {   // vente couverte par des achats observés : résultat réalisé
    const f = Math.min(1, e[2] / e[0]), cost = e[1] * f, got = e[3] * Math.min(1, e[0] / e[2]);
    o.pnl += got - cost; o.inv += cost;
    if (f >= 0.9) { o.rt++; if (got > cost) o.win++; o.holds.push((e[5] - e[4]) / 1000); }
  }
}
const sol = solUsd || 140;
const rows = [];
let seen = 0;
for (const w of Object.keys(kol)) if (!W[w]) W[w] = { pnl: 0, inv: 0, rt: 0, win: 0, n: 0, pools: 0, mev: 0, holds: [], buy: 0, t1: NOW, t0: NOW, kolOnly: true };
for (const [w, o] of Object.entries(W)) {
  if (!o.kolOnly) seen++;
  if (!o.rt && !kol[w]) continue;
  o.holds.sort((a, b) => a - b); const hold = o.holds.length ? o.holds[o.holds.length >> 1] : 0;
  const span = Math.max(H, o.t1 - o.t0), tpd = o.n / (span / (24 * H));
  const avg = o.n ? (o.buy / Math.max(1, o.n / 2)) : 0;
  const bot = o.mev >= 2 || o.n > 300 || (o.n >= 20 && hold > 0 && hold < 10) || (o.n >= 10 && avg < 5);
  const r = { w, pnl: +(o.pnl / sol).toFixed(3), roi: o.inv > 0 ? +(o.pnl / o.inv).toFixed(4) : 0, win: o.rt ? +(o.win / o.rt).toFixed(3) : 0, rt: o.rt, n: o.n, pools: o.pools, hold: Math.round(hold), tpd: Math.round(tpd), bot: bot ? 1 : 0, src: 'gt' };
  const k = kol[w];
  if (k) { r.src = o.rt ? 'gt+kolscan' : 'kolscan'; r.name = k.n; r.k7 = k.p7; r.k30 = k.p30; r.k1 = k.p1;
    const kw = (k.w7 || 0) + (k.l7 || 0); if (!o.rt) { r.pnl = +(k.p7 || 0).toFixed(3); r.win = kw ? +((k.w7 || 0) / kw).toFixed(3) : 0; r.rt = kw; r.roi = null; r.tpd = Math.round(kw * 2 / 7); /* ~2 transactions par aller-retour */ } }
  // éligible : PnL réalisé ≥ 1 SOL, ROI ≥ 5 %, ≥ 3 allers-retours, détention médiane ≥ 30 s, pas un robot
  r.ok = !r.bot && r.pnl >= 1 && (r.roi == null || r.roi >= 0.05) && r.rt >= 3 && (r.src === 'kolscan' || r.hold >= 30) ? 1 : 0;
  // candidat à surveiller en direct (pré-filtre bon marché ; la copie exige ensuite des résultats mesurés en direct)
  r.cand = r.ok || (!r.bot && r.pnl >= 0.3 && (r.roi == null || r.roi >= 0.05) && r.rt >= 2 && (r.src === 'kolscan' || r.hold >= 30)) ? 1 : 0;
  rows.push(r);
}
// score : rangs PnL (SOL), ROI, taux de gain ; bonus Kolscan 30 j positif
const rank = (key) => { const v = rows.slice().sort((a, b) => key(b) - key(a)); const m = new Map(); v.forEach((r, i) => m.set(r.w, rows.length > 1 ? 1 - i / (rows.length - 1) : 1)); return m; };
const rp = rank((r) => r.pnl), rr = rank((r) => r.roi == null ? 0.2 : r.roi), rw = rank((r) => r.win);
for (const r of rows) r.score = Math.round(100 * (0.4 * rp.get(r.w) + 0.35 * rr.get(r.w) + 0.25 * rw.get(r.w)) + (r.k30 > 0 ? 3 : 0));
rows.sort((a, b) => (b.ok - a.ok) || (b.cand - a.cand) || (b.score - a.score));
const analyzed = rows.slice(0, 3000), eligible = rows.filter((r) => r.ok), cands = rows.filter((r) => r.cand);
const run = { at: NOW, ...stat, read, sol: +sol.toFixed(2), seen, analyzed: analyzed.length, scored: rows.length, eligible: eligible.length, cands: cands.length, wp: Object.keys(S.wp).length, ms: Date.now() - NOW };
S.runs = [run, ...(S.runs || [])].slice(0, 48);
fs.writeFileSync(DIR + '/state.json.gz', zlib.gzipSync(JSON.stringify(S)));
fs.writeFileSync(DIR + '/analyzed.json.gz', zlib.gzipSync(JSON.stringify({ at: NOW, run, rows: analyzed })));
fs.writeFileSync(DIR + '/short.json', JSON.stringify({ v: 1, at: NOW, run, top: cands.slice(0, 300).map(({ w, name, src, pnl, roi, win, rt, hold, tpd, score, ok }) => ({ w, n: name || '', src, pnl, roi, win, rt, hold, tpd, score, ok })) }));
console.log(JSON.stringify(run));
