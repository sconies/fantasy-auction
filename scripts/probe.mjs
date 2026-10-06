// Diagnostic: which data sources answer from GitHub Actions, and what they return. Not part of the data job.
const UA = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', accept: '*/*' };
const espnFilter = JSON.stringify({ players: { limit: 2, sortDraftRanks: { sortPriority: 100, sortAsc: true, value: 'STANDARD' } } });
const probes = [
  ['espn-fantasy-2027', 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/2027/segments/0/leaguedefaults/3?view=kona_player_info', { 'x-fantasy-filter': espnFilter }],
  ['espn-roster', 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/2/roster'],
  ['espn-core-depth', 'https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/2027/teams/2/depthcharts'],
  ['espn-web-depth', 'https://www.espn.com/nba/team/depth/_/name/bos'],
  ['fantasypros-proj', 'https://www.fantasypros.com/nba/projections/overall.php'],
  ['fantasypros-depth', 'https://www.fantasypros.com/nba/depth-charts.php'],
  ['rotowire-lineups', 'https://www.rotowire.com/basketball/nba-lineups.php'],
  ['hashtag-proj', 'https://hashtagbasketball.com/fantasy-basketball-projections'],
  ['bbmonster-depth', 'https://basketballmonster.com/nbadepthcharts.aspx'],
  ['yahoo-auction', 'https://basketball.fantasysports.yahoo.com/nba/draftanalysis?type=auction'],
  ['nba-stats', 'https://stats.nba.com/stats/commonallplayers?LeagueID=00&Season=2026-27&IsOnlyCurrentSeason=1', { referer: 'https://www.nba.com/', origin: 'https://www.nba.com' }],
  ['nba-cdn-players', 'https://cdn.nba.com/static/json/staticData/playerIndex.json'],
];
for (const [name, url, extra] of probes) {
  try {
    const res = await fetch(url, { headers: { ...UA, ...(extra ?? {}) }, signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    console.log(`\n=== ${name} ${res.status} ${text.length} bytes ${res.headers.get('content-type')}`);
    let snip = text;
    try { snip = JSON.stringify(JSON.parse(text)).slice(0, 2500); } catch { snip = text.replace(/\s+/g, ' ').slice(0, 300) + ' ... ' + (text.match(/(starter|depth|minutes|PG1|Projected)[^<]{0,200}/i)?.[0] ?? ''); }
    console.log(snip);
  } catch (e) { console.log(`\n=== ${name} ERROR ${e.message}`); }
}
