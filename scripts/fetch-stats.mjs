// Fetch per-game stats for the last two NBA seasons from Basketball Reference.
// Writes data/raw/bbref-<season>.json. Runs in the GitHub Action (the sandbox cannot reach the site).
// Usage: node scripts/fetch-stats.mjs [season ...]   (season = year it ends, e.g. 2026 for 2025-26)
import { writeFileSync, mkdirSync } from 'node:fs';
import { parsePerGame } from './bbref-parse.mjs';

const seasons = process.argv.slice(2).map(Number).filter(Boolean);
if (!seasons.length) seasons.push(2026, 2025);
mkdirSync('data/raw', { recursive: true });

for (const season of seasons) {
  const url = `https://www.basketball-reference.com/leagues/NBA_${season}_per_game.html`;
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (fantasy-auction data job; one request per day)' } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const rows = parsePerGame(await res.text());
  if (rows.length < 300) throw new Error(`${url}: parsed only ${rows.length} players; the page layout may have changed`);
  writeFileSync(`data/raw/bbref-${season}.json`, JSON.stringify({ season, source: url, fetchedAt: new Date().toISOString(), players: rows }, null, 0) + '\n');
  console.log(`${season}: ${rows.length} players`);
  await new Promise(r => setTimeout(r, 4000)); // Basketball Reference asks for under 20 requests a minute
}
