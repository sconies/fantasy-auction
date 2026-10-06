// Which Jev flags predict what ESPN's preseason projection gets wrong, stat by stat?
//
// For each past season T: ESPN's preseason projection (data/history/espn-preseason-T.json), what happened
// (Basketball Reference), and Jev's flags on every preseason Rotowire note about the player
// (data/history/rotowire-preseason-T.flags.json; a player's flag = the strongest mention).
// Targets are ESPN's misses: games, minutes, per-36 rates, shooting percentages.
//
// Leave one season out: fit on three seasons, predict the fourth. A flag is used only if its effect has
// the same sign in every training season on its own (so one odd year can't create a rule). The final
// effects (all four seasons) go to data/model/flag-effects.json; the honest test goes to data/eval-flags.json.
import { writeFileSync, mkdirSync } from 'node:fs';
import { normName } from '../lib/value.mjs';
import { FLAG_KEYS } from '../lib/flags.mjs';
import { json, raw, projections, score } from '../lib/evaluate.mjs';
import { applyFlagEffects, TARGETS } from '../lib/flag-effects.mjs';

const SEASONS = [2023, 2024, 2025, 2026].filter(T => json(`data/history/rotowire-preseason-${T}.flags.json`) && json(`data/history/espn-preseason-${T}.json`) && raw(T));
const FEATURES = [...FLAG_KEYS, 'has_news'];

// One row per ESPN-projected player-season: features and ESPN's miss on each target.
function rows(T) {
  const flags = new Map();
  for (const it of json(`data/history/rotowire-preseason-${T}.flags.json`).items) {
    if (!it.flags) continue;
    const k = normName(it.player), f = flags.get(k) ?? {};
    for (const key of FLAG_KEYS) f[key] = Math.max(f[key] ?? 0, it.flags[key] ?? 0);
    flags.set(k, f);
  }
  const act = new Map(raw(T).map(r => [normName(r.name), r]));
  const out = [];
  for (const p of json(`data/history/espn-preseason-${T}.json`).players) {
    if (p.min < 12) continue;
    const k = normName(p.name), f = flags.get(k), a = act.get(k);
    const x = Object.fromEntries(FEATURES.map(c => [c, c === 'has_news' ? (f ? 1 : 0) : f?.[c] ?? 0]));
    const y = { games: (a?.g ?? 0) - p.projG };
    if (a && a.g >= 15 && a.min >= 10) {
      y.min = a.min - p.min;
      for (const s of ['pts', 'reb', 'ast', 'stl', 'blk', 'tpm', 'tov', 'fga', 'fta']) y[`${s}36`] = (36 * a[s]) / a.min - (36 * p[s]) / p.min;
      if (p.fga > 1 && a.fga > 1) y.fgPct = a.fgm / a.fga - p.fgm / p.fga;
      if (p.fta > 0.7 && a.fta > 0.7) y.ftPct = a.ftm / a.fta - p.ftm / p.fta;
    }
    out.push({ T, name: p.name, x, y });
  }
  return out;
}

// Ridge regression with an unpenalised intercept.
function ridge(data, target, feats, lambda) {
  const d = data.filter(r => r.y[target] != null);
  if (d.length < 30 || !feats.length) return { b0: d.length ? d.reduce((s, r) => s + r.y[target], 0) / d.length : 0, b: {} };
  const n = d.length, k = feats.length;
  const mx = feats.map(f => d.reduce((s, r) => s + r.x[f], 0) / n), my = d.reduce((s, r) => s + r.y[target], 0) / n;
  const A = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? lambda * n : 0)));
  const v = Array(k).fill(0);
  for (const r of d) {
    const xc = feats.map((f, i) => r.x[f] - mx[i]), yc = r.y[target] - my;
    for (let i = 0; i < k; i++) { v[i] += xc[i] * yc; for (let j = 0; j < k; j++) A[i][j] += xc[i] * xc[j]; }
  }
  for (let i = 0; i < k; i++) { // Gaussian elimination
    let p = i; for (let r = i + 1; r < k; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]]; [v[i], v[p]] = [v[p], v[i]];
    for (let r = 0; r < k; r++) if (r !== i && A[i][i]) { const m = A[r][i] / A[i][i]; for (let c = i; c < k; c++) A[r][c] -= m * A[i][c]; v[r] -= m * v[i]; }
  }
  const b = Object.fromEntries(feats.map((f, i) => [f, A[i][i] ? v[i] / A[i][i] : 0]));
  return { b0: my - feats.reduce((s, f, i) => s + b[f] * mx[i], 0), b };
}

// Flags whose effect keeps its sign in every training season fitted on its own.
function stableFeatures(data, target, seasons, lambda) {
  const per = seasons.map(T => ridge(data.filter(r => r.T === T), target, FEATURES, lambda).b);
  return FEATURES.filter(f => per.every(b => Math.sign(b[f] ?? 0) === Math.sign(per[0][f] ?? 0) && Math.abs(b[f] ?? 0) > 1e-9));
}

function fitModel(data, seasons, lambda) {
  const model = {};
  for (const t of TARGETS) {
    const feats = stableFeatures(data, t, seasons, lambda);
    const m = ridge(data, t, feats, lambda);
    model[t] = { intercept: +m.b0.toFixed(4), effects: Object.fromEntries(Object.entries(m.b).map(([f, v]) => [f, +v.toFixed(4)])) };
  }
  return model;
}

const predict = (model, t, x, withIntercept) => (withIntercept ? model[t].intercept : 0) + Object.entries(model[t].effects).reduce((s, [f, b]) => s + b * (x[f] ?? 0), 0);

const all = SEASONS.flatMap(rows);
const LAMBDAS = [0.01, 0.03, 0.1, 0.3];
const results = [];
for (const lambda of LAMBDAS) {
  // Error on each held-out season: ESPN as is, ESPN + its average miss (intercept), ESPN + flags.
  const err = Object.fromEntries(TARGETS.map(t => [t, { espn: 0, bias: 0, flags: 0, n: 0 }]));
  for (const h of SEASONS) {
    const train = all.filter(r => r.T !== h), test = all.filter(r => r.T === h);
    const m = fitModel(train, SEASONS.filter(T => T !== h), lambda);
    for (const t of TARGETS) for (const r of test) {
      if (r.y[t] == null) continue;
      const e = err[t];
      e.espn += r.y[t] ** 2; e.bias += (r.y[t] - m[t].intercept) ** 2; e.flags += (r.y[t] - predict(m, t, r.x, true)) ** 2; e.n++;
    }
  }
  results.push({ lambda, err });
}
// Pick the penalty with the lowest total held-out error relative to ESPN, summed over targets.
const gain = r => TARGETS.reduce((s, t) => s + (r.err[t].flags / r.err[t].espn), 0);
const best = results.reduce((a, b) => (gain(b) < gain(a) ? b : a));
const lambda = best.lambda;

// End to end: held-out ESPN projections with and without the flag effects, scored like every backtest.
const flagsFor = T => {
  const m = new Map();
  for (const r of all.filter(r => r.T === T)) m.set(normName(r.name), r.x);
  return m;
};
const valueTest = [];
for (const h of SEASONS) {
  const m = fitModel(all.filter(r => r.T !== h), SEASONS.filter(T => T !== h), lambda);
  const base = projections.espn(h), x = flagsFor(h);
  const adjusted = new Map([...base].map(([k, p]) => [k, applyFlagEffects(p, x.get(k) ?? null, m)]));
  const a = score(h, base), b = score(h, adjusted);
  valueTest.push({ season: h, espn: { spearman: +a.spearman.toFixed(3), mae: +a.maeDollars.toFixed(2) }, espnPlusFlags: { spearman: +b.spearman.toFixed(3), mae: +b.maeDollars.toFixed(2) } });
}

const final = fitModel(all, SEASONS, lambda);
const reduction = Object.fromEntries(TARGETS.map(t => {
  const e = best.err[t];
  return [t, { players: e.n, errorVsEspn: +(1 - e.flags / e.espn).toFixed(4), errorVsEspnPlusBias: +(1 - e.flags / e.bias).toFixed(4) }];
}));
mkdirSync('data/model', { recursive: true });
writeFileSync('data/model/flag-effects.json', JSON.stringify({ builtAt: new Date().toISOString(), seasons: SEASONS, lambda, players: all.length,
  note: 'Effect of each Jev flag (probability 0-1) on ESPN projection misses. games: games played; min: minutes per game; *36: per-36-minute rates; fgPct/ftPct: percentage points (0-1). Intercept = ESPN average miss.', model: final }, null, 1) + '\n');
writeFileSync('data/eval-flags.json', JSON.stringify({ builtAt: new Date().toISOString(), seasons: SEASONS, lambda,
  method: 'Leave one season out. Squared-error reduction on held-out seasons versus ESPN as is, and versus ESPN corrected only for its average miss. A flag is used only when its effect keeps its sign in every training season.',
  heldOutErrorReduction: reduction, valueTest, lambdas: results.map(r => ({ lambda: r.lambda, score: +gain(r).toFixed(4) })) }, null, 1) + '\n');

console.log(`players ${all.length} (${all.filter(r => r.x.has_news).length} with preseason news), seasons ${SEASONS.join(',')}, lambda ${lambda}`);
console.table(Object.fromEntries(Object.entries(reduction).map(([t, v]) => [t, { n: v.players, 'vs ESPN': `${(v.errorVsEspn * 100).toFixed(1)}%`, 'vs ESPN+bias': `${(v.errorVsEspnPlusBias * 100).toFixed(1)}%` }])));
console.table(valueTest.map(v => ({ season: v.season, 'ESPN rho': v.espn.spearman, '+flags rho': v.espnPlusFlags.spearman, 'ESPN MAE': v.espn.mae, '+flags MAE': v.espnPlusFlags.mae })));
for (const t of TARGETS) { const e = Object.entries(final[t].effects).filter(([, v]) => Math.abs(v) > 1e-3).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])); console.log(t.padEnd(7), 'bias', final[t].intercept, '|', e.map(([f, v]) => `${f} ${v > 0 ? '+' : ''}${v}`).join(', ')); }
