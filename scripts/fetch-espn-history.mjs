// Fetch ESPN's preseason projections (and the actual results) for past seasons, for the backtest.
// Usage: node scripts/fetch-espn-history.mjs 2026 2025   -> data/sources/espn-history-<season>.json
import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('data/sources', { recursive: true });
for (const season of process.argv.slice(2).map(Number)) {
  const filter = { players: { limit: 600, sortDraftRanks: { sortPriority: 100, sortAsc: true, value: 'STANDARD' },
    filterStatsForTopScoringPeriodIds: { value: 2, additionalValue: [`10${season}`, `00${season}`] } } };
  const res = await fetch(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${season}/segments/0/leaguedefaults/3?view=kona_player_info`,
    { headers: { 'user-agent': 'Mozilla/5.0', 'x-fantasy-filter': JSON.stringify(filter) } });
  const text = await res.text();
  console.log(season, res.status, text.length);
  if (res.ok) writeFileSync(`data/sources/espn-history-${season}.json`, text);
}
