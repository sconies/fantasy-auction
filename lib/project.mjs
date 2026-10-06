// Projection from past seasons. Shared by scripts/build-players.mjs and scripts/backtest.mjs,
// so the backtest measures exactly the method the app uses.

export const STATS = ['min', 'fgm', 'fga', 'ftm', 'fta', 'tpm', 'pts', 'reb', 'ast', 'stl', 'blk', 'tov'];

export const DEFAULT_PARAMS = {
  priorWeight: 0.5,     // older season counts at this share of its games
  healthyGames: 70,     // games played regress toward this
  gamesRegress: 0.3,    // ...by this share
  maxGames: 78,
  age: true,            // apply the age curve to counting stats
};

const ageNudge = age => (age <= 21 ? 1.07 : age <= 23 ? 1.04 : age <= 25 ? 1.02 : age <= 29 ? 1 : age <= 31 ? 0.98 : age <= 33 ? 0.95 : 0.91);

// cur, old: per-game rows for the last and the season before (old may be missing).
export function projectPlayer(cur, old, params = DEFAULT_PARAMS) {
  const P = { ...DEFAULT_PARAMS, ...params };
  const wc = cur.g, wo = old ? old.g * P.priorWeight : 0;
  const blend = k => (cur[k] * wc + (old ? old[k] * wo : 0)) / (wc + wo || 1);
  const age = cur.age + 1;
  const nudge = P.age ? ageNudge(age) : 1;
  const p = { id: cur.id, name: cur.name, team: cur.team, age };
  for (const k of STATS) p[k] = +(blend(k) * (k === 'min' ? 1 : nudge)).toFixed(2);
  const gHist = old ? 0.65 * cur.g + 0.35 * old.g : cur.g;
  p.projG = Math.round(Math.min(P.maxGames, (1 - P.gamesRegress) * gHist + P.gamesRegress * P.healthyGames));
  return p;
}

// Everyone worth projecting: enough minutes and enough games to mean something.
export function projectAll(curRows, oldRows = [], params) {
  const oldById = new Map(oldRows.map(p => [p.id, p]));
  const out = [];
  for (const c of curRows) {
    const o = oldById.get(c.id);
    const p = projectPlayer(c, o, params);
    if (p.min >= 12 && c.g + (o?.g ?? 0) >= 15) out.push(p);
  }
  return out;
}
