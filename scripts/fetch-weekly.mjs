// Weekly category totals for every relevant player in a past season, from ESPN game logs.
// Used by scripts/simulate-h2h.mjs to test valuation formulas on real head-to-head weeks.
// Usage: node scripts/fetch-weekly.mjs 2026   -> data/history/weekly-2026.json
import { writeFileSync, mkdirSync } from 'node:fs';

const ID = { pts: 0, blk: 1, stl: 2, ast: 3, reb: 6, tov: 11, fgm: 13, fga: 14, ftm: 15, fta: 16, tpm: 17, min: 40 };
mkdirSync('data/history', { recursive: true });
for (const season of process.argv.slice(2).map(Number)) {
  const filter = { players: { limit: 450, sortAppliedStatTotal: { sortAsc: false, sortPriority: 1, value: `00${season}` },
    filterStatsForTopScoringPeriodIds: { value: 200, additionalValue: [`00${season}`] } } };
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${season}/segments/0/leaguedefaults/3?view=kona_player_info`;
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', 'x-fantasy-filter': JSON.stringify(filter) } });
  if (!res.ok) throw new Error(`${season}: ${res.status}`);
  const data = await res.json();
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
  if (games < 15000) throw new Error(`only ${games} player-games: ESPN may not have returned full game logs`);
}
