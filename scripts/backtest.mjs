// Backtest: how good are the values? For each past season T, build the preseason projection several
// ways, value each with the app's engine, value what actually happened the same way, and compare.
//   model   - this app's stats projection from T-1 and T-2 (Basketball Reference)
//   espn    - ESPN's own preseason projection for T (data/sources/espn-history-T.json)
//   blend w - w × ESPN + (1-w) × model, stat by stat
// Usage: node scripts/backtest.mjs   -> data/eval.json and a printed summary
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { computeValues, DEFAULT_LEAGUE, normName } from '../lib/value.mjs';
import { projectAll, DEFAULT_PARAMS, STATS } from '../lib/project.mjs';

const league = existsSync('data/league.json') ? { ...DEFAULT_LEAGUE, ...JSON.parse(readFileSync('data/league.json', 'utf8')) } : DEFAULT_LEAGUE;
const N = league.teams * league.rosterSize;
const json = f => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);
const raw = s => json(`data/raw/bbref-${s}.json`)?.players ?? null;
const byName = rows => new Map(rows.map(r => [normName(r.name), { ...r, id: normName(r.name) }]));

function spearman(xs, ys) {
  const rank = a => { const idx = a.map((v, i) => [v, i]).sort((p, q) => q[0] - p[0]); const r = []; idx.forEach(([, i], k) => (r[i] = k + 1)); return r; };
  const rx = rank(xs), ry = rank(ys), n = xs.length, m = (n + 1) / 2;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i] - m) * (ry[i] - m); dx += (rx[i] - m) ** 2; dy += (ry[i] - m) ** 2; }
  return num / Math.sqrt(dx * dy);
}

// Combine two per-game projections stat by stat; a player in only one source keeps that one.
export function blend(a, b, w) {
  const out = new Map(a);
  for (const [k, pb] of b) {
    const pa = a.get(k);
    if (!pa) { out.set(k, pb); continue; }
    const p = { ...pa };
    for (const s of [...STATS, 'projG']) p[s] = (1 - w) * (pa[s] ?? 0) + w * (pb[s] ?? 0);
    out.set(k, p);
  }
  return out;
}

const projections = {
  model: (T, params = DEFAULT_PARAMS) => raw(T - 1) && byName(projectAll(raw(T - 1), raw(T - 2) ?? [], params)),
  naive: T => raw(T - 1) && byName(raw(T - 1).filter(c => c.min >= 12 && c.g >= 15).map(c => ({ ...c, projG: c.g }))),
  // data/history/espn-preseason-T.json is ESPN's preseason projection for T, saved by scripts/save-espn-history.mjs.
  espn: T => {
    const h = json(`data/history/espn-preseason-${T}.json`);
    return h && byName(h.players.filter(p => p.min >= 8));
  },
};

function score(T, proj) {
  const act = raw(T);
  if (!act || !proj) return null;
  const pv = computeValues([...proj.values()], { league });
  const av = computeValues([...byName(act).values()].map(r => ({ ...r, projG: r.g })), { league });
  const P = new Map(pv.map(p => [p.id, p])), A = new Map(av.map(p => [p.id, p]));
  const ids = new Set([...pv.slice(0, N), ...av.slice(0, N)].map(p => p.id));
  const pairs = [...ids].map(id => ({ name: P.get(id)?.name ?? A.get(id)?.name, proj: P.get(id)?.dollars ?? 0, act: A.get(id)?.dollars ?? 0,
    projRank: P.get(id)?.rank ?? null, actRank: A.get(id)?.rank ?? null, unprojected: !P.has(id) }));
  const drafted = pairs.filter(p => p.projRank && p.projRank <= N);
  const top50 = pairs.filter(p => p.projRank && p.projRank <= 50);
  return {
    target: T, n: pairs.length,
    spearman: spearman(pairs.map(p => p.proj), pairs.map(p => p.act)),
    maeDollars: drafted.reduce((s, p) => s + Math.abs(p.proj - p.act), 0) / drafted.length,
    top50StayedTop75: top50.filter(p => p.actRank && p.actRank <= 75).length / top50.length,
    wastedShare: drafted.filter(p => p.act === 0).reduce((s, p) => s + p.proj, 0) / drafted.reduce((s, p) => s + p.proj, 0),
    unprojectedValue: pairs.filter(p => p.unprojected && p.actRank <= N).reduce((s, p) => s + p.act, 0),
    unprojected: pairs.filter(p => p.unprojected && p.actRank <= N).sort((a, b) => b.act - a.act).slice(0, 6).map(p => `${p.name} $${Math.round(p.act)}`),
    biggestMisses: pairs.filter(p => !p.unprojected).sort((a, b) => Math.abs(b.proj - b.act) - Math.abs(a.proj - a.act)).slice(0, 8)
      .map(p => `${p.name}: projected $${Math.round(p.proj)}, worth $${Math.round(p.act)}`),
  };
}

// Only seasons where every compared method exists, so the averages are like for like.
const all = [2022, 2023, 2024, 2025, 2026];
const espnSeasons = all.filter(T => projections.espn(T) && raw(T) && raw(T - 1));
const statSeasons = all.filter(T => raw(T) && raw(T - 1));
const variants = [
  ['naive: last season as it happened', T => projections.naive(T), statSeasons],
  ['model: stats only (Basketball Reference)', T => projections.model(T), statSeasons],
  ['model, no age curve', T => projections.model(T, { ...DEFAULT_PARAMS, age: false }), statSeasons],
  ['model, seasons equal', T => projections.model(T, { ...DEFAULT_PARAMS, priorWeight: 1 }), statSeasons],
  ['model, strong games regression', T => projections.model(T, { ...DEFAULT_PARAMS, gamesRegress: 0.5 }), statSeasons],
  ['— same seasons as ESPN —', null, espnSeasons],
  ['model (ESPN seasons)', T => projections.model(T), espnSeasons],
  ['ESPN preseason projection', T => projections.espn(T), espnSeasons],
  ...[0.25, 0.5, 0.75].map(w => [`blend: ${w * 100}% ESPN + ${100 - w * 100}% model`, T => blend(projections.model(T), projections.espn(T), w), espnSeasons]),
];
const mean = (rs, k) => rs.reduce((s, r) => s + r[k], 0) / rs.length;
const summary = [];
for (const [label, fn, seasons] of variants) {
  if (!fn) { summary.push({ label, seasons }); continue; }
  const rs = seasons.map(T => score(T, fn(T))).filter(Boolean);
  if (!rs.length) continue;
  summary.push({ label, seasons, spearman: +mean(rs, 'spearman').toFixed(3), maeDollars: +mean(rs, 'maeDollars').toFixed(2),
    top50StayedTop75: +mean(rs, 'top50StayedTop75').toFixed(3), wastedShare: +mean(rs, 'wastedShare').toFixed(3),
    unprojectedValue: Math.round(mean(rs, 'unprojectedValue')), perSeason: rs.map(r => ({ target: r.target, spearman: +r.spearman.toFixed(3), maeDollars: +r.maeDollars.toFixed(2) })) });
}
const detail = { model: statSeasons.map(T => score(T, projections.model(T))), espn: espnSeasons.map(T => score(T, projections.espn(T))) };

writeFileSync('data/eval.json', JSON.stringify({ builtAt: new Date().toISOString(),
  method: 'Project season T before it starts, value it with the app engine, compare with the same valuation of what happened in T (Basketball Reference). rho = rank correlation over everyone projected or actually worth drafting; MAE = average $ miss on the 182 projected to be drafted; top50→top75 = share of the projected top 50 who finished top 75; wasted = share of dollars spent on players worth $0.',
  summary, detail }, null, 1) + '\n');
console.table(summary.map(s => ({ variant: s.label, seasons: s.seasons.join(','), rho: s.spearman, 'MAE $': s.maeDollars, 'top50→75': s.top50StayedTop75, 'wasted': s.wastedShare, 'unseen $': s.unprojectedValue })));
