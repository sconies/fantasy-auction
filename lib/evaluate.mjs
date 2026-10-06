// Shared by the backtests: load past seasons, build preseason projections, and score a projection
// against what happened (rank correlation and dollar miss, valued with the app's own engine).
import { readFileSync, existsSync } from 'node:fs';
import { computeValues, DEFAULT_LEAGUE, normName } from './value.mjs';
import { projectAll, DEFAULT_PARAMS, STATS } from './project.mjs';

export const league = existsSync('data/league.json') ? { ...DEFAULT_LEAGUE, ...JSON.parse(readFileSync('data/league.json', 'utf8')) } : DEFAULT_LEAGUE;
const N = league.teams * league.rosterSize;
export const json = f => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);
export const raw = s => json(`data/raw/bbref-${s}.json`)?.players ?? null;
export const byName = rows => new Map(rows.map(r => [normName(r.name), { ...r, id: normName(r.name) }]));

export function spearman(xs, ys) {
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

export const projections = {
  model: (T, params = DEFAULT_PARAMS) => raw(T - 1) && byName(projectAll(raw(T - 1), raw(T - 2) ?? [], params)),
  naive: T => raw(T - 1) && byName(raw(T - 1).filter(c => c.min >= 12 && c.g >= 15).map(c => ({ ...c, projG: c.g }))),
  // data/history/espn-preseason-T.json is ESPN's preseason projection for T, saved by scripts/save-espn-history.mjs.
  espn: T => {
    const h = json(`data/history/espn-preseason-${T}.json`);
    return h && byName(h.players.filter(p => p.min >= 8));
  },
};

export function score(T, proj) {
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

