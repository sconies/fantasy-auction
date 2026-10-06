// Backtest: how good are the values? For each past season T, build the preseason projection several
// ways, value each with the app's engine, value what actually happened the same way, and compare.
//   model   - this app's stats projection from T-1 and T-2 (Basketball Reference)
//   espn    - ESPN's own preseason projection for T (data/sources/espn-history-T.json)
//   blend w - w × ESPN + (1-w) × model, stat by stat
// Usage: node scripts/backtest.mjs   -> data/eval.json and a printed summary
import { writeFileSync } from 'node:fs';
import { DEFAULT_PARAMS } from '../lib/project.mjs';
import { raw, blend, projections, score } from '../lib/evaluate.mjs';

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
