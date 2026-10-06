// Apply fitted flag effects (data/model/flag-effects.json) to a per-game projection.
// Effects move the inputs: games, minutes, per-36 rates, shooting percentages. The intercept (ESPN's
// average miss) is applied too, because it was part of the model that won the held-out test.
export const TARGETS = ['games', 'min', 'pts36', 'reb36', 'ast36', 'stl36', 'blk36', 'tpm36', 'tov36', 'fga36', 'fta36', 'fgPct', 'ftPct'];
const RATE = { pts36: 'pts', reb36: 'reb', ast36: 'ast', stl36: 'stl', blk36: 'blk', tpm36: 'tpm', tov36: 'tov', fga36: 'fga', fta36: 'fta' };

export function flagDelta(model, target, x, { intercept = true } = {}) {
  const m = model?.[target];
  if (!m) return 0;
  return (intercept ? m.intercept : 0) + (x ? Object.entries(m.effects).reduce((s, [f, b]) => s + b * (x[f] ?? 0), 0) : 0);
}

// x: { flag: probability } or null for a player with no news.
export function applyFlagEffects(p, x, model, opts = {}) {
  if (!model || p.min == null) return p;
  const q = { ...p };
  const d = t => flagDelta(model, t, x ?? {}, opts);
  const min0 = p.min || 1;
  const min1 = Math.max(4, Math.min(40, min0 + d('min')));
  for (const [t, s] of Object.entries(RATE)) {
    const per36 = Math.max(0, (36 * (p[s] ?? 0)) / min0 + d(t));
    q[s] = (per36 * min1) / 36;
  }
  // Keep makes consistent with the new attempts and percentages.
  const fgPct = Math.min(0.75, Math.max(0.3, (p.fga ? p.fgm / p.fga : 0.46) + d('fgPct')));
  const ftPct = Math.min(0.95, Math.max(0.4, (p.fta ? p.ftm / p.fta : 0.75) + d('ftPct')));
  q.fgm = q.fga * fgPct; q.ftm = q.fta * ftPct;
  q.min = min1;
  q.projG = Math.max(0, Math.min(82, Math.round((p.projG ?? 0) + d('games'))));
  return q;
}
