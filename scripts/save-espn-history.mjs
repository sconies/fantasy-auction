// Slim ESPN's archived preseason projections (data/sources/espn-history-T.json, from fetch-espn-history.mjs)
// into data/history/espn-preseason-T.json, which the backtest reads and the repository keeps.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { parseEspnPlayers } from '../lib/sources.mjs';
mkdirSync('data/history', { recursive: true });
for (const T of process.argv.slice(2).map(Number)) {
  const f = `data/sources/espn-history-${T}.json`;
  if (!existsSync(f)) { console.log(`${T}: no ${f}`); continue; }
  const players = parseEspnPlayers(JSON.parse(readFileSync(f, 'utf8')), T).filter(p => p.proj)
    .map(p => ({ name: p.name, ...Object.fromEntries(Object.entries(p.proj).map(([k, v]) => [k, +(+v).toFixed(2)])) }));
  writeFileSync(`data/history/espn-preseason-${T}.json`, JSON.stringify({ season: T, source: 'ESPN fantasy API, preseason projection (statSourceId 1)', players }) + '\n');
  console.log(`${T}: ${players.length} players`);
}
