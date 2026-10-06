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
// Pick the penalty with the lowest held-out error relative to the bias-only correction: flags must earn
// their place against "ESPN plus its average miss", not against raw ESPN.
const gain = r => TARGETS.reduce((s, t) => s + (r.err[t].flags / r.err[t].bias), 0);
const best = results.reduce((a, b) => (gain(b) < gain(a) ? b : a));
const lambda = best.lambda;
// Per stat: no correction, bias only, or bias plus flags, whichever wins on held-out seasons. Flags need
// a 1% edge over bias only, bias a 0.5% edge over nothing (a random-flag dry run passes neither).
const choice = Object.fromEntries(TARGETS.map(t => {
  const e = best.err[t];
  if (e.flags < 0.99 * e.bias && e.flags < e.espn) return [t, 'flags'];
  if (e.bias < 0.995 * e.espn) return [t, 'bias'];
  return [t, 'none'];
}));
const restrict = (m, withFlags) => Object.fromEntries(TARGETS.map(t => [t, choice[t] === 'none' ? { intercept: 0, effects: {} }
  : choice[t] === 'bias' || !withFlags ? { intercept: m[t].intercept, effects: {} } : m[t]]));

// End to end: held-out ESPN projections as is, with the bias corrections, and with bias plus flags.
const flagsFor = T => {
  const m = new Map();
  for (const r of all.filter(r => r.T === T)) m.set(normName(r.name), r.x);
  return m;
};
const short = r => ({ spearman: +r.spearman.toFixed(3), mae: +r.maeDollars.toFixed(2) });
const valueTest = [];
for (const h of SEASONS) {
  const m = fitModel(all.filter(r => r.T !== h), SEASONS.filter(T => T !== h), lambda);
  const base = projections.espn(h), x = flagsFor(h);
  const withModel = mm => new Map([...base].map(([k, p]) => [k, applyFlagEffects(p, x.get(k) ?? null, mm)]));
  valueTest.push({ season: h, espn: short(score(h, base)), espnPlusBias: short(score(h, withModel(restrict(m, false)))), espnPlusFlags: short(score(h, withModel(restrict(m, true)))) });
}
const meanOf = (k, f) => valueTest.reduce((s, v) => s + v[k][f], 0) / valueTest.length;
const beats = (a, b) => meanOf(a, 'mae') < meanOf(b, 'mae') && meanOf(a, 'spearman') >= meanOf(b, 'spearman') - 0.002;
const decision = {
  useFlags: Object.values(choice).includes('flags') && beats('espnPlusFlags', 'espnPlusBias'),
  useBias: Object.values(choice).includes('bias') && beats('espnPlusBias', 'espn'),
  choice,
  mean: Object.fromEntries(['espn', 'espnPlusBias', 'espnPlusFlags'].map(k => [k, { spearman: +meanOf(k, 'spearman').toFixed(3), mae: +meanOf(k, 'mae').toFixed(2) }])),
};
decision.use = decision.useFlags || decision.useBias;
console.log('decision', JSON.stringify(decision));

// Risk: the spread of held-out dollar misses (what happened minus the projection) for players projected
// to be drafted, by tier. The app shows a player's value with his tier's 10th-90th percentile range.
const TIERS = [
  { name: 'injury', label: 'Injury risk', anyOf: ['absence', 'recovering', 'injury_history', 'minutes_limit', 'load_managed'], threshold: 0.5 },
  { name: 'role', label: 'Role in flux', anyOf: ['competition', 'new_team', 'role_up', 'role_down', 'breakout', 'opening', 'crowded', 'starter', 'bench', 'out_of_rotation'], threshold: 0.5 },
  { name: 'steady', label: 'Steady', anyOf: [], threshold: 0.5 },
];
const tierOf = x => TIERS.find(t => !t.anyOf.length || t.anyOf.some(f => (x?.[f] ?? 0) >= t.threshold));
const resid = Object.fromEntries(TIERS.map(t => [t.name, []]));
for (const h of SEASONS) {
  const m = fitModel(all.filter(r => r.T !== h), SEASONS.filter(T => T !== h), lambda);
  const base = projections.espn(h), x = flagsFor(h);
  const mm = decision.useFlags ? restrict(m, true) : decision.useBias ? restrict(m, false) : null;
  const adjusted = mm ? new Map([...base].map(([k, p]) => [k, applyFlagEffects(p, x.get(k) ?? null, mm)])) : base;
  for (const pr of score(h, adjusted).pairs.filter(p => p.projRank && p.projRank <= 182)) resid[tierOf(x.get(normName(pr.name))).name].push(pr.act - pr.proj);
}
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
const riskModel = { builtAt: new Date().toISOString(), seasons: SEASONS, note: 'low/high = 10th/90th percentile of (actual $ - projected $) on held-out seasons, players projected top 182',
  tiers: TIERS.map(t => ({ ...t, players: resid[t.name].length, low: Math.round(q(resid[t.name], 0.1)), median: Math.round(q(resid[t.name], 0.5)), high: Math.round(q(resid[t.name], 0.9)) })) };
writeFileSync('data/model/risk.json', JSON.stringify(riskModel, null, 1) + '\n');
console.table(riskModel.tiers.map(t => ({ tier: t.label, players: t.players, '10th pct': t.low, median: t.median, '90th pct': t.high })));

const final = restrict(fitModel(all, SEASONS, lambda), decision.useFlags);
const reduction = Object.fromEntries(TARGETS.map(t => {
  const e = best.err[t];
  return [t, { players: e.n, choice: choice[t], biasVsEspn: +(1 - e.bias / e.espn).toFixed(4), flagsVsBias: +(1 - e.flags / e.bias).toFixed(4) }];
}));
mkdirSync('data/model', { recursive: true });
writeFileSync('data/model/flag-effects.json', JSON.stringify({ builtAt: new Date().toISOString(), seasons: SEASONS, lambda, players: all.length,
  note: 'Effect of each Jev flag (probability 0-1) on ESPN projection misses. games: games played; min: minutes per game; *36: per-36-minute rates; fgPct/ftPct: percentage points (0-1). Intercept = ESPN average miss.', model: final }, null, 1) + '\n');
writeFileSync('data/eval-flags.json', JSON.stringify({ builtAt: new Date().toISOString(), seasons: SEASONS, lambda,
  method: 'Leave one season out. Per stat, choose no correction, ESPN bias only, or bias plus Jev flags by held-out squared error (flags need a 1% edge over bias). Flags are switched on only if the value backtest with them beats bias-only on held-out seasons. A flag enters a stat only when its effect keeps its sign in every training season.',
  decision, heldOutErrorReduction: reduction, valueTest, lambdas: results.map(r => ({ lambda: r.lambda, score: +gain(r).toFixed(4) })) }, null, 1) + '\n');

console.log(`players ${all.length} (${all.filter(r => r.x.has_news).length} with preseason news), seasons ${SEASONS.join(',')}, lambda ${lambda}`);
console.table(Object.fromEntries(Object.entries(reduction).map(([t, v]) => [t, { n: v.players, choice: v.choice, 'bias vs ESPN': `${(v.biasVsEspn * 100).toFixed(1)}%`, 'flags vs bias': `${(v.flagsVsBias * 100).toFixed(1)}%` }])));
console.table(valueTest.map(v => ({ season: v.season, 'ESPN rho': v.espn.spearman, '+bias rho': v.espnPlusBias.spearman, '+flags rho': v.espnPlusFlags.spearman, 'ESPN MAE': v.espn.mae, '+bias MAE': v.espnPlusBias.mae, '+flags MAE': v.espnPlusFlags.mae })));
for (const t of TARGETS) { const e = Object.entries(final[t].effects).filter(([, v]) => Math.abs(v) > 1e-3).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])); console.log(t.padEnd(7), 'bias', final[t].intercept, '|', e.map(([f, v]) => `${f} ${v > 0 ? '+' : ''}${v}`).join(', ')); }
