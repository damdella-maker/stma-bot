// STMA Bot · sélection des meilleurs traders Hyperliquid (perps, long + short) pour la copie en ARGENT FICTIF.
// Données publiques uniquement (classement + historique d'exécutions), aucun secret. Publie hl.json (lu par le Worker).
// Étapes : classement (~40 Mo, ~48 000 comptes) → préfiltre (capital ≥ 20 k$, PnL 30 j et total > 0, rendement 30 j 5–300 %,
//   rotation du volume raisonnable = pas un teneur de marché) → historique des 2 000 dernières exécutions de ~30 candidats
//   par passage (rafraîchissement tournant, cache 6 h) → note hors classement : rendement réalisé 7 j / 30 j net de frais,
//   taux de gain, régularité, nombre de trades/jour (copiables à la minute : ≤ 150 exécutions/jour).
import fs from 'node:fs'; import zlib from 'node:zlib';
const DIR = process.argv[2] || 'data', NOW = Date.now(), DAY = 86400000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let S = { v: 1, c: {} };
try { S = JSON.parse(zlib.gunzipSync(fs.readFileSync(DIR + '/hl_state.json.gz'))); } catch (e) { console.log('hl : nouvel état'); }
const stat = { lb: 0, pre: 0, fetched: 0, fail: 0, r429: 0 };
async function info(body) {
  for (let a = 0; a < 4; a++) {
    try { const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (r.status === 429) { stat.r429++; await sleep(10000 * (a + 1)); continue; }
      if (!r.ok) { await sleep(2000); continue; } return await r.json(); } catch (e) { await sleep(2000); }
  }
  stat.fail++; return null;
}
const wp = (r, k) => { const x = (r.windowPerformances || []).find((p) => p[0] === k); return x ? { pnl: +x[1].pnl, roi: +x[1].roi, vlm: +x[1].vlm } : { pnl: 0, roi: 0, vlm: 0 }; };
let rows = [];
try { const r = await fetch('https://stats-data.hyperliquid.xyz/Mainnet/leaderboard'); rows = (await r.json()).leaderboardRows || []; } catch (e) { console.log('hl : classement indisponible', e.message); }
stat.lb = rows.length;
const pre = [];
for (const r of rows) {
  const av = +r.accountValue; if (!(av >= 20000)) continue;
  const m = wp(r, 'month'), a = wp(r, 'allTime'), w = wp(r, 'week');
  if (!(m.pnl >= 3000 && a.pnl > 0 && m.roi >= 0.05 && m.roi <= 3)) continue;
  const turn = m.vlm / av; if (turn > 400 || turn < 2) continue;
  pre.push({ w: r.ethAddress.toLowerCase(), n: r.displayName || null, av, m30: m.roi, w7: w.roi, all: a.pnl, turn, lb: (m.pnl / av) * Math.min(1, av / 1e5) });
}
pre.sort((x, y) => y.lb - x.lb); const cand = pre.slice(0, 150); stat.pre = pre.length;
// rafraîchissement tournant : nouveaux d'abord, puis les plus anciens (cache 6 h) ; ~30 par passage, 2,5 s entre appels (limite publique)
const due = cand.filter((c) => !S.c[c.w] || NOW - S.c[c.w].at > 6 * 3600000).sort((a, b) => ((S.c[a.w] || {}).at || 0) - ((S.c[b.w] || {}).at || 0)).slice(0, +process.env.HL_PER_RUN || 30);
for (const c of due) {
  const f = await info({ type: 'userFills', user: c.w, aggregateByTime: true }); await sleep(2500);
  if (!Array.isArray(f)) continue; stat.fetched++;
  const byDay = {}; let closes = 0, wins = 0, n = 0, t0 = NOW;
  for (const x of f) { const d = Math.floor(x.time / DAY); const v = (+x.closedPnl || 0) - (+x.fee || 0); byDay[d] = (byDay[d] || 0) + v; n++; t0 = Math.min(t0, x.time);
    if (+x.closedPnl) { closes++; if (+x.closedPnl > 0) wins++; } }
  const span = Math.max(1, (NOW - t0) / DAY);
  S.c[c.w] = { at: NOW, byDay, closes, wins, fpd: n / span, span };
}
for (const k of Object.keys(S.c)) if (NOW - S.c[k].at > 7 * DAY) delete S.c[k];
// note (uniquement sur l'historique réalisé, pas sur le classement qui contient du latent)
const dk = Math.floor(NOW / DAY), out = [];
for (const c of cand) {
  const h = S.c[c.w]; if (!h) continue;
  const sum = (a, b) => { let s = 0; for (let d = dk - b; d < dk - a; d++) s += h.byDay[d] || 0; return s / c.av; };
  const r7 = sum(0, 7), r30 = sum(0, 30), days = []; for (let d = dk - 14; d < dk; d++) days.push((h.byDay[d] || 0) / c.av);
  const mu = days.reduce((a, b) => a + b, 0) / days.length, sd = Math.sqrt(days.reduce((a, b) => a + (b - mu) ** 2, 0) / days.length) || 1e-9;
  const win = h.closes ? h.wins / h.closes : 0, act = days.filter((x) => x).length;
  const copyable = h.fpd <= 150 && act >= 3 && r30 <= 3 && r7 <= 2;   // rendements irréalistes = dépôts/retraits, exclus
  const edge = r7 > 0 && h.closes >= 3 && win >= 0.45;
  const score = Math.round(1000 * (mu / sd) * Math.sqrt(14)) / 1000;
  out.push({ w: c.w, n: c.n, av: Math.round(c.av), r7: +r7.toFixed(4), r30: +r30.toFixed(4), win: +win.toFixed(3), closes: h.closes, fpd: +h.fpd.toFixed(1), act, score, ok: copyable && r30 > 0 ? 1 : 0, edge: edge ? 1 : 0 });
}
out.sort((a, b) => (b.ok - a.ok) || (b.edge - a.edge) || (b.score - a.score));
const top = out.slice(0, 60);
fs.writeFileSync(DIR + '/hl.json', JSON.stringify({ at: NOW, run: { ...stat, scored: out.length, ok: out.filter((x) => x.ok).length, edge: out.filter((x) => x.ok && x.edge).length }, top }));
fs.writeFileSync(DIR + '/hl_state.json.gz', zlib.gzipSync(JSON.stringify(S)));
console.log(JSON.stringify({ hl: stat, scored: out.length, top3: top.slice(0, 3).map((x) => [x.w.slice(0, 8), x.score, x.r7, x.r30]) }));
