// Valuation engine: per-game projections -> 9-cat z-scores -> auction dollars.
// Runs unchanged in the browser and in Node (tests, scripts).

export const CATS = ['fg', 'ft', 'tpm', 'pts', 'reb', 'ast', 'stl', 'blk', 'tov'];
export const CAT_LABEL = { fg: 'FG%', ft: 'FT%', tpm: '3PM', pts: 'PTS', reb: 'REB', ast: 'AST', stl: 'STL', blk: 'BLK', tov: 'TO' };
const COUNTING = ['fgm', 'fga', 'ftm', 'fta', 'tpm', 'pts', 'reb', 'ast', 'stl', 'blk', 'tov'];

export const DEFAULT_LEAGUE = { teams: 14, budget: 200, rosterSize: 13, minBid: 1, fullSeasonGames: 80 };

// Apply a player's accepted adjustments (news, injuries, your own edits).
// Adjustments change the inputs (games, minutes, a stat), never the dollar value directly.
export function applyAdjustments(p, adjustments = []) {
  const out = { ...p };
  let minutesMult = 1;
  for (const a of adjustments) {
    if (a.games != null) out.projG = a.games;
    if (a.gamesDelta) out.projG = (out.projG ?? 0) + a.gamesDelta;
    if (a.minutesMult) minutesMult *= a.minutesMult;
    if (a.minutes && p.min) minutesMult *= a.minutes / p.min;
    if (a.statMult) for (const [k, m] of Object.entries(a.statMult)) if (out[k] != null) out[k] *= m;
  }
  if (minutesMult !== 1) {
    for (const k of COUNTING) if (out[k] != null) out[k] *= minutesMult;
    out.min = (out.min ?? 0) * minutesMult;
  }
  out.projG = Math.max(0, Math.min(82, Math.round(out.projG ?? 0)));
  return out;
}

function meanSd(xs) {
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length;
  return [m, Math.sqrt(v) || 1];
}

// players: [{id, name, pos:[], projG, min, fgm, fga, ftm, fta, tpm, pts, reb, ast, stl, blk, tov}] per game.
// opts.punt: categories to ignore. Returns players sorted by value with z, value, rank, dollars.
// opts.tau: per-category week-to-week variance (per game, in z units' raw scale). Adding it to the spread
//   between players gives head-to-head "G-scores": a category that swings a lot from week to week is
//   less reliably won, so a lead in it is worth less. opts.cap: limit any single category's |z|.
export function computeValues(players, { league = DEFAULT_LEAGUE, punt = [], tau = null, cap = null } = {}) {
  const n = league.teams * league.rosterSize;
  const cats = CATS.filter(c => !punt.includes(c));
  const avail = p => Math.min(p.projG, league.fullSeasonGames) / league.fullSeasonGames;
  const rows = players.filter(p => p.projG > 0 && p.fga + p.fta > 0).map(p => ({ ...p }));
  if (!rows.length) return [];

  // Start from a rough pool, then re-centre the z-scores on the players who actually get drafted.
  let pool = [...rows].sort((a, b) => (b.pts + b.reb + b.ast) * avail(b) - (a.pts + a.reb + a.ast) * avail(a)).slice(0, n);
  let ranked = rows;
  let replPerGame = null; // per-game level of the best undrafted players: who plays the games a starter misses
  for (let iter = 0; iter < 4; iter++) {
    const fgPct = pool.reduce((s, p) => s + p.fgm, 0) / pool.reduce((s, p) => s + p.fga, 0);
    const ftPct = pool.reduce((s, p) => s + p.ftm, 0) / pool.reduce((s, p) => s + p.fta, 0);
    // Percentages count by impact: how many makes above an average shooter on the same volume.
    const raw = p => ({ fg: p.fgm - fgPct * p.fga, ft: p.ftm - ftPct * p.fta, tpm: p.tpm, pts: p.pts, reb: p.reb, ast: p.ast, stl: p.stl, blk: p.blk, tov: p.tov });
    const poolRaw = pool.map(raw);
    const dist = Object.fromEntries(CATS.map(c => [c, meanSd(poolRaw.map(r => r[c]))]));
    for (const p of rows) {
      const r = raw(p);
      p.z = Object.fromEntries(CATS.map(c => {
        const [m, sd] = dist[c];
        let z = (r[c] - m) / (tau?.[c] != null ? Math.sqrt(sd * sd + tau[c]) : sd);
        if (cap) z = Math.max(-cap, Math.min(cap, z));
        return [c, c === 'tov' ? -z : z];
      }));
      p.perGame = cats.reduce((s, c) => s + p.z[c], 0);
    }
    if (replPerGame == null) replPerGame = rows.map(p => p.perGame).sort((a, b) => b - a)[n] ?? 0;
    // A missed game is worth what a replacement player would have given, not zero.
    for (const p of rows) p.value = (p.perGame - replPerGame) * avail(p);
    ranked = [...rows].sort((a, b) => b.value - a.value);
    pool = ranked.slice(0, n);
    const next = ranked.slice(n, n + 6);
    if (next.length) replPerGame = next.reduce((s, p) => s + p.perGame, 0) / next.length;
  }

  // Replacement level is the best player left undrafted; dollars above $1 follow value above him.
  const repl = ranked[n]?.value ?? ranked[ranked.length - 1].value;
  const spare = league.teams * league.budget - n * league.minBid;
  const surplus = pool.reduce((s, p) => s + Math.max(0, p.value - repl), 0) || 1;
  ranked.forEach((p, i) => {
    p.rank = i + 1;
    p.vorp = p.value - repl;
    p.dollars = i < n ? league.minBid + (Math.max(0, p.vorp) / surplus) * spare : 0;
  });
  return ranked;
}

export function tierOf(dollars) {
  if (dollars >= 50) return 1;
  if (dollars >= 38) return 2;
  if (dollars >= 27) return 3;
  if (dollars >= 18) return 4;
  if (dollars >= 10) return 5;
  if (dollars >= 4) return 6;
  if (dollars >= 1) return 7;
  return 8;
}

// Live auction state. picks: [{playerId, team (index), price}]. priceOf(p) is the dollar figure you trust
// (model + your override). Inflation spreads the money still in the room over the value still on the board.
export function draftState(ranked, picks, { league = DEFAULT_LEAGUE, teamCount = league.teams, priceOf = p => p.dollars } = {}) {
  const teams = Array.from({ length: teamCount }, () => ({ spent: 0, players: [] }));
  const drafted = new Set();
  for (const pk of picks) {
    const t = teams[pk.team];
    if (!t) continue;
    t.spent += pk.price;
    t.players.push(pk.playerId);
    drafted.add(pk.playerId);
  }
  for (const t of teams) {
    t.left = league.budget - t.spent;
    t.slots = league.rosterSize - t.players.length;
    t.maxBid = t.slots > 0 ? t.left - (t.slots - 1) * league.minBid : 0;
  }
  const slots = teams.reduce((s, t) => s + Math.max(0, t.slots), 0);
  const money = teams.reduce((s, t) => s + (t.slots > 0 ? t.left : 0), 0);
  const board = ranked.filter(p => !drafted.has(p.id)).sort((a, b) => priceOf(b) - priceOf(a));
  const boardSurplus = board.slice(0, slots).reduce((s, p) => s + Math.max(0, priceOf(p) - league.minBid), 0);
  const inflation = boardSurplus > 0 ? Math.max(0, money - slots * league.minBid) / boardSurplus : 1;
  const adjusted = p => (priceOf(p) <= 0 ? 0 : league.minBid + Math.max(0, priceOf(p) - league.minBid) * inflation);
  return { teams, drafted, slots, money, inflation, adjusted, board };
}

// Category totals (sum of per-game z) for a set of players.
export function categoryTotals(players) {
  const t = Object.fromEntries(CATS.map(c => [c, 0]));
  for (const p of players) for (const c of CATS) t[c] += p.z?.[c] ?? 0;
  return t;
}

// How well a player fits a roster: his z in the categories where the roster is weakest count more.
export function fitScore(player, roster, punt = []) {
  const totals = categoryTotals(roster);
  const cats = CATS.filter(c => !punt.includes(c));
  const per = roster.length || 1;
  return cats.reduce((s, c) => {
    const need = 1 + Math.max(0, -totals[c] / per); // weak category -> weight above 1
    return s + need * (player.z?.[c] ?? 0);
  }, 0);
}

export function normName(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '');
}
