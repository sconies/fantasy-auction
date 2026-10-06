// Backtest: how good are the values? For each past season T, project it from T-1 and T-2 with the
// app's own projection code, value the projection, value what actually happened the same way, and
// compare. Also tries simpler and different settings so we can see what each choice is worth.
// Usage: node scripts/backtest.mjs            -> writes data/eval.json and prints a summary
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { computeValues, DEFAULT_LEAGUE } from '../lib/value.mjs';
import { projectAll, DEFAULT_PARAMS } from '../lib/project.mjs';

const league = existsSync('data/league.json') ? { ...DEFAULT_LEAGUE, ...JSON.parse(readFileSync('data/league.json', 'utf8')) } : DEFAULT_LEAGUE;
const N = league.teams * league.rosterSize;
const raw = s => (existsSync(`data/raw/bbref-${s}.json`) ? JSON.parse(readFileSync(`data/raw/bbref-${s}.json`, 'utf8')).players : null);

// What a season was actually worth: its real per-game stats over the games actually played.
function actualValues(rows) {
  return computeValues(rows.map(r => ({ ...r, projG: r.g })), { league });
}

function spearman(xs, ys) {
  const rank = a => { const idx = a.map((v, i) => [v, i]).sort((p, q) => q[0] - p[0]); const r = []; idx.forEach(([, i], k) => (r[i] = k + 1)); return r; };
  const rx = rank(xs), ry = rank(ys), n = xs.length;
  const mx = (n + 1) / 2;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - mx); dx += (rx[i] - mx) ** 2; dy += (ry[i] - mx) ** 2; }
  return num / Math.sqrt(dx * dy);
}

export function scoreSeason(target, params, { variant = 'model' } = {}) {
  const cur = raw(target - 1), old = raw(target - 2), act = raw(target);
  if (!cur || !act) return null;
  let proj;
  if (variant === 'naive') proj = cur.filter(c => c.min >= 12 && c.g >= 15).map(c => ({ ...c, age: c.age + 1, projG: c.g })); // last season, as it happened
  else proj = projectAll(cur, old ?? [], params);
  const pv = computeValues(proj, { league });
  const av = actualValues(act);
  const pById = new Map(pv.map(p => [p.id, p])), aById = new Map(av.map(p => [p.id, p]));
  // Judge everyone who mattered: projected to be drafted, or actually worth drafting.
  const ids = new Set([...pv.slice(0, N), ...av.slice(0, N)].map(p => p.id));
  const pairs = [...ids].map(id => ({ id, name: pById.get(id)?.name ?? aById.get(id)?.name, proj: pById.get(id)?.dollars ?? 0, act: aById.get(id)?.dollars ?? 0,
    projRank: pById.get(id)?.rank ?? null, actRank: aById.get(id)?.rank ?? null, unprojected: !pById.has(id) }));
  const drafted = pairs.filter(p => p.projRank && p.projRank <= N);
  const top50 = pairs.filter(p => p.projRank && p.projRank <= 50);
  const mae = drafted.reduce((s, p) => s + Math.abs(p.proj - p.act), 0) / drafted.length;
  const missed = pairs.filter(p => p.unprojected && p.actRank <= N);
  return {
    target, variant, n: pairs.length,
    spearman: +spearman(pairs.map(p => p.proj), pairs.map(p => p.act)).toFixed(3),
    maeDollars: +mae.toFixed(2),
    top50StayedTop75: +(top50.filter(p => p.actRank && p.actRank <= 75).length / top50.length).toFixed(3),
    // Of the money a model-follower would spend, how much bought nothing (players worth $0 that season).
    wastedShare: +(drafted.filter(p => p.act === 0).reduce((s, p) => s + p.proj, 0) / drafted.reduce((s, p) => s + p.proj, 0)).toFixed(3),
    unprojectedValue: Math.round(missed.reduce((s, p) => s + p.act, 0)), // rookies and players who didn't play T-1: invisible to the model
    unprojected: missed.sort((a, b) => b.act - a.act).slice(0, 8).map(p => `${p.name} $${Math.round(p.act)}`),
    biggestMisses: pairs.filter(p => !p.unprojected).sort((a, b) => Math.abs(b.proj - b.act) - Math.abs(a.proj - a.act)).slice(0, 10)
      .map(p => `${p.name}: projected $${Math.round(p.proj)}, worth $${Math.round(p.act)}`),
  };
}

const targets = [2023, 2024, 2025, 2026].filter(t => raw(t) && raw(t - 1));
if (!targets.length) { console.log('Need at least two consecutive seasons in data/raw'); process.exit(0); }

const variants = [
  ['naive: last season as it happened', null, 'naive'],
  ['model (current settings)', DEFAULT_PARAMS],
  ['model, no age curve', { ...DEFAULT_PARAMS, age: false }],
  ['model, last season only', { ...DEFAULT_PARAMS, priorWeight: 0 }],
  ['model, seasons equal', { ...DEFAULT_PARAMS, priorWeight: 1 }],
  ['model, no games regression', { ...DEFAULT_PARAMS, gamesRegress: 0 }],
  ['model, strong games regression', { ...DEFAULT_PARAMS, gamesRegress: 0.5 }],
];
const avg = (rs, k) => +(rs.reduce((s, r) => s + r[k], 0) / rs.length).toFixed(3);
const summary = variants.map(([label, params, variant]) => {
  const rs = targets.map(t => scoreSeason(t, params, { variant: variant ?? 'model' })).filter(Boolean);
  return { label, seasons: rs.map(r => r.target), spearman: avg(rs, 'spearman'), maeDollars: avg(rs, 'maeDollars'),
    top50StayedTop75: avg(rs, 'top50StayedTop75'), wastedShare: avg(rs, 'wastedShare'), unprojectedValue: Math.round(avg(rs, 'unprojectedValue')) };
});
const detail = targets.map(t => scoreSeason(t, DEFAULT_PARAMS)).filter(Boolean);

const out = { builtAt: new Date().toISOString(), method: 'Project season T from T-1 and T-2, value it, compare with the same valuation of what happened in T', summary, detail };
writeFileSync('data/eval.json', JSON.stringify(out, null, 1) + '\n');
console.table(summary.map(s => ({ variant: s.label, seasons: s.seasons.join(','), rho: s.spearman, 'MAE $': s.maeDollars, 'top50→top75': s.top50StayedTop75, 'wasted $': s.wastedShare, 'unprojected $': s.unprojectedValue })));
for (const d of detail) console.log(`\n${d.target}: rho ${d.spearman}, MAE $${d.maeDollars}\n  invisible to the model: ${d.unprojected.join('; ')}\n  biggest misses: ${d.biggestMisses.slice(0, 6).join('; ')}`);
