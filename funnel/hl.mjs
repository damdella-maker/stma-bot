// STMA Bot · Hyperliquid — liste d'OBSERVATION (aucune copie, même papier ; consigne de Damian du 16/11).
// Données publiques uniquement, aucun secret. Publie hl.json (lu par le Worker, qui observe ces portefeuilles chaque minute).
// Règles : ≥ 90 jours d'historique ; rendements hebdomadaires tirés de l'historique de portefeuille (PnL cumulé / valeur du
// compte : dépôts et retraits exclus) ; Sharpe annualisé ; drawdown max ≤ 25 % ; Sharpe « dégonflé » (Bailey & López de Prado)
// qui tient compte du nombre de candidats testés ; jamais de fenêtre « semaine » ou « mois » du classement.
// Limite connue : aucun instantané historique du classement n'existe → l'univers est celui d'aujourd'hui (biais de survie) ;
// c'est pourquoi cette liste sert à OBSERVER, pas à copier.
import fs from 'node:fs'; import zlib from 'node:zlib';
const DIR = process.argv[2] || 'data', NOW = Date.now(), DAY = 86400000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let S = { v: 2, c: {} };
try { const x = JSON.parse(zlib.gunzipSync(fs.readFileSync(DIR + '/hl_state.json.gz'))); if (x.v === 2) S = x; } catch (e) { console.log('hl : nouvel état'); }
const stat = { lb: 0, pool: 0, fetched: 0, fail: 0 };
async function info(body) {
  for (let a = 0; a < 4; a++) {
    try { const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (r.status === 429) { await sleep(10000 * (a + 1)); continue; } if (!r.ok) { await sleep(2000); continue; } return await r.json(); } catch (e) { await sleep(2000); }
  }
  stat.fail++; return null;
}
// loi normale : fonction de répartition et quantile (approximations standard)
const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2), p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
const iPhi = (p) => { let lo = -10, hi = 10; for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (Phi(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };
export function weekly(av, pnl) {
  const out = []; for (let i = 1; i < Math.min(av.length, pnl.length); i++) { const a = +av[i - 1][1]; if (a < 1000) continue; out.push({ t: +av[i][0], r: (+pnl[i][1] - +pnl[i - 1][1]) / a, g: (+av[i][0] - +av[i - 1][0]) / DAY }); } return out;
}
export function stats(R) {
  const x = R.map((o) => o.r), n = x.length; if (n < 10) return null;
  const m = x.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / n) || 1e-9;
  const sk = x.reduce((a, b) => a + ((b - m) / sd) ** 3, 0) / n, ku = x.reduce((a, b) => a + ((b - m) / sd) ** 4, 0) / n;
  let eq = 1, pk = 1, mdd = 0; for (const v of x) { eq *= 1 + Math.max(v, -0.99); pk = Math.max(pk, eq); mdd = Math.max(mdd, 1 - eq / pk); }
  const gap = R.reduce((a, o) => a + o.g, 0) / n;
  return { n, sr: m / sd, sh: (m / sd) * Math.sqrt(365 / gap), sk, ku, mdd, tot: eq - 1, days: Math.round((R[n - 1].t - R[0].t) / DAY + gap) };
}
// Sharpe dégonflé : probabilité que le vrai Sharpe dépasse le meilleur attendu par hasard parmi N essais
export function deflated(s, N, varSR) {
  const g = 0.5772156649, sr0 = Math.sqrt(Math.max(varSR, 1e-12)) * ((1 - g) * iPhi(1 - 1 / N) + g * iPhi(1 - 1 / (N * Math.E)));
  const den = Math.sqrt(Math.max(1e-9, 1 - s.sk * s.sr + ((s.ku - 1) / 4) * s.sr * s.sr));
  return Phi(((s.sr - sr0) * Math.sqrt(s.n - 1)) / den);
}
if (import.meta.url === 'file://' + process.argv[1]) {
  let rows = [];
  try { const r = await fetch('https://stats-data.hyperliquid.xyz/Mainnet/leaderboard'); rows = (await r.json()).leaderboardRows || []; } catch (e) { console.log('hl : classement indisponible', e.message); }
  stat.lb = rows.length;
  // univers : comptes actifs (volume total ≥ 1 M$, capital ≥ 10 k$) ; AUCUN filtre sur la performance de la semaine ou du mois
  const at = (r, k) => { const x = (r.windowPerformances || []).find((p) => p[0] === k); return x ? x[1] : {}; };
  const pool = rows.filter((r) => +r.accountValue >= 10000 && +at(r, 'allTime').vlm >= 1e6).map((r) => r.ethAddress.toLowerCase());
  stat.pool = pool.length;
  // échantillon tournant : 60 portefeuilles par passage (2,5 s entre appels), cache 7 jours
  const due = pool.filter((w) => !S.c[w] || NOW - S.c[w].at > 7 * DAY).sort(() => Math.random() - 0.5).slice(0, +process.env.HL_PER_RUN || 60);
  for (const w of due) {
    const d = await info({ type: 'portfolio', user: w }); await sleep(2500); if (!Array.isArray(d)) continue; stat.fetched++;
    const a = (Object.fromEntries(d).allTime) || {}; const R = weekly(a.accountValueHistory || [], a.pnlHistory || []);
    const s = R.length && (R[R.length - 1].t - R[0].t) >= 90 * DAY ? stats(R) : null;
    S.c[w] = { at: NOW, s };
  }
  for (const k of Object.keys(S.c)) if (NOW - S.c[k].at > 21 * DAY) delete S.c[k];
  const tested = Object.entries(S.c).filter(([, x]) => x.s);
  const N = Math.max(2, tested.length), srs = tested.map(([, x]) => x.s.sr), mu = srs.reduce((a, b) => a + b, 0) / (srs.length || 1);
  const varSR = srs.reduce((a, b) => a + (b - mu) ** 2, 0) / (srs.length || 1);
  const out = tested.map(([w, x]) => ({ w, sh: +x.s.sh.toFixed(2), dsr: +deflated(x.s, N, varSR).toFixed(3), mdd: +x.s.mdd.toFixed(3), days: x.s.days, n: x.s.n, tot: +x.s.tot.toFixed(3) }))
    .filter((x) => x.mdd <= 0.25 && x.sh > 0).sort((a, b) => b.dsr - a.dsr);
  const top = out.slice(0, 10);
  for (const t of top) { const f = await info({ type: 'userFills', user: t.w, aggregateByTime: true }); await sleep(1500);   // trades par portefeuille (2 000 dernières exécutions)
    if (Array.isArray(f) && f.length) { const span = Math.max(1, (NOW - Math.min(...f.map((x) => x.time))) / DAY); t.tpd = +(f.filter((x) => +x.closedPnl).length / span).toFixed(1); } t.ok = 1; }
  fs.writeFileSync(DIR + '/hl.json', JSON.stringify({ at: NOW, mode: 'observation', run: { ...stat, tested: N, kept: out.length }, top }));
  fs.writeFileSync(DIR + '/hl_state.json.gz', zlib.gzipSync(JSON.stringify(S)));
  console.log(JSON.stringify({ hl: stat, tested: N, kept: out.length, top3: top.slice(0, 3).map((x) => [x.w.slice(0, 8), x.sh, x.dsr, x.mdd, x.days]) }));
}
