// Download every external source this app reads, unparsed, into data/sources/.
// Runs on GitHub Actions; the parsers (scripts/parse-sources.mjs) work from these files.
import { writeFileSync, mkdirSync } from 'node:fs';

const SEASON = 2027; // ESPN names a season by the year it ends
const UA = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' };
mkdirSync('data/sources', { recursive: true });
const get = async (url, headers = {}, tries = 3) => {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`${res.status}`);
      return await res.text();
    } catch (e) {
      if (i >= tries) throw new Error(`${url}: ${e.message}`);
      await new Promise(r => setTimeout(r, 3000 * i));
    }
  }
};
const save = (f, s) => { writeFileSync(`data/sources/${f}`, s); console.log(`${f}: ${s.length} bytes`); };
const failures = [];
const attempt = async (label, fn) => { try { await fn(); } catch (e) { failures.push(`${label}: ${e.message}`); console.error(`FAILED ${label}: ${e.message}`); } };

// 1. ESPN fantasy: projections (source 1) and last season (source 0), positions, injuries, market auction values.
await attempt('espn-players', async () => {
  const filter = { players: {
    limit: 600, sortDraftRanks: { sortPriority: 100, sortAsc: true, value: 'STANDARD' },
    filterStatsForTopScoringPeriodIds: { value: 2, additionalValue: [`10${SEASON}`, `00${SEASON - 1}`] },
  } };
  const s = await get(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${SEASON}/segments/0/leaguedefaults/3?view=kona_player_info`, { 'x-fantasy-filter': JSON.stringify(filter) });
  save('espn-players.json', s);
});

// 2. ESPN depth charts and rosters for all 30 teams (team ids 1-30).
await attempt('espn-depth', async () => {
  const teams = {};
  for (let id = 1; id <= 30; id++) {
    const roster = JSON.parse(await get(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${id}/roster`));
    const depth = JSON.parse(await get(`https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/${SEASON}/teams/${id}/depthcharts`));
    teams[id] = {
      abbr: roster.team?.abbreviation, name: roster.team?.displayName,
      roster: (roster.athletes ?? []).map(a => ({ id: a.id, name: a.fullName, pos: a.position?.abbreviation, age: a.age, exp: a.experience?.years, injuries: a.injuries?.map(i => i.status) })),
      depth: Object.fromEntries(Object.entries(depth.items?.[0]?.positions ?? {}).map(([pos, v]) => [pos, (v.athletes ?? []).sort((a, b) => a.rank - b.rank).map(a => /athletes\/(\d+)/.exec(a.athlete?.$ref ?? '')?.[1])])),
    };
  }
  save('espn-depth.json', JSON.stringify({ season: SEASON, fetchedAt: new Date().toISOString(), teams }));
});

// 3. Consensus and other projections, and Yahoo's own auction prices (pages, parsed later).
await attempt('fantasypros', async () => save('fantasypros.html', await get('https://www.fantasypros.com/nba/projections/overall.php')));
await attempt('hashtag', async () => save('hashtag.html', await get('https://hashtagbasketball.com/fantasy-basketball-projections')));
await attempt('yahoo-auction', async () => save('yahoo-auction.html', await get('https://basketball.fantasysports.yahoo.com/nba/draftanalysis?type=auction')));

writeFileSync('data/sources/fetch-log.json', JSON.stringify({ fetchedAt: new Date().toISOString(), failures }, null, 1) + '\n');
if (failures.length) console.error(`${failures.length} source(s) failed`);
