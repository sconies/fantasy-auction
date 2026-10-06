// Weekly category totals for every relevant player in a past season, from ESPN game logs.
// Used by scripts/simulate-h2h.mjs to test valuation formulas on real head-to-head weeks.
// Usage: node scripts/fetch-weekly.mjs 2026   -> data/history/weekly-2026.json
import { writeFileSync, mkdirSync } from 'node:fs';

const ID = { pts: 0, blk: 1, stl: 2, ast: 3, reb: 6, tov: 11, fgm: 13, fga: 14, ftm: 15, fta: 16, tpm: 17, min: 40 };
mkdirSync('data/history', { recursive: true });
for (const season of process.argv.slice(2).map(Number)) {
  // ESPN truncates big answers, so ask 50 players at a time.
  const data = { players: [] };
  for (let offset = 0; offset < 450; offset += 50) {
    const filter = { players: { limit: 50, offset, sortAppliedStatTotal: { sortAsc: false, sortPriority: 1, value: `00${season}` },
      filterStatsForTopScoringPeriodIds: { value: 200, additionalValue: [`00${season}`] } } };
    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${season}/segments/0/leaguedefaults/3?view=kona_player_info`;
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', 'x-fantasy-filter': JSON.stringify(filter) } });
    if (!res.ok) throw new Error(`${season} offset ${offset}: ${res.status}`);
    data.players.push(...(await res.json()).players);
    await new Promise(r => setTimeout(r, 500));
  }
  let first = Infinity, games = 0;
  for (const { player } of data.players) for (const s of player.stats ?? []) if (s.statSplitTypeId === 5 && s.seasonId === season && s.stats?.[42]) first = Math.min(first, s.scoringPeriodId);
  const players = [];
  for (const { player } of data.players) {
    const weeks = {};
    for (const s of player.stats ?? []) {
      if (s.statSplitTypeId !== 5 || s.seasonId !== season || !s.stats?.[42]) continue; // a game he played
      const w = Math.floor((s.scoringPeriodId - first) / 7);
      const t = (weeks[w] ??= { gp: 0, ...Object.fromEntries(Object.keys(ID).map(k => [k, 0])) });
      t.gp++; games++;
      for (const [k, id] of Object.entries(ID)) t[k] += +(s.stats[id] ?? 0);
    }
    if (Object.keys(weeks).length) players.push({ name: player.fullName, espnId: String(player.id), weeks });
  }
  writeFileSync(`data/history/weekly-${season}.json`, JSON.stringify({ season, source: 'ESPN game logs, grouped into 7-day weeks from the first game day', players }) + '\n');
  console.log(`${season}: ${players.length} players, ${games} player-games`);
  // The top ~235 players by season total are enough to cover a 182-player draft pool; require full logs for them.
  if (players.length < 200 || games / players.length < 35) throw new Error(`${players.length} players, ${(games / players.length).toFixed(0)} games each: game logs look incomplete`);
}
