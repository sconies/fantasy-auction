// Diagnostic: where can we get past seasons' preseason player text? Not part of the data job.
const UA = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' };
const espn = async (season, view) => {
  const f = { players: { filterIds: { value: [3112335, 4066261, 4278073] } } };
  const r = await fetch(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${season}/segments/0/leaguedefaults/3?view=${view}`, { headers: { ...UA, 'x-fantasy-filter': JSON.stringify(f) } });
  const d = await r.json().catch(() => ({}));
  console.log('espn', season, view, r.status, (d.players ?? []).map(p => `${p.player?.fullName}: ${(p.player?.seasonOutlook ?? '').slice(0, 80)}`).join(' | '));
};
for (const v of ['kona_playercard', 'kona_player_info', 'players_wl', 'kona_player_outlook']) await espn(2025, v);
// Wayback snapshots of Rotowire NBA news, preseason 2024
for (const url of ['rotowire.com/basketball/news.php', 'www.rotowire.com/basketball/news.php', 'www.cbssports.com/fantasy/basketball/players/news/all/', 'www.fantasypros.com/nba/news/']) {
  const r = await fetch(`https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&from=20240901&to=20241025&output=json&filter=statuscode:200&collapse=timestamp:8`, { headers: UA });
  const rows = await r.json().catch(() => []);
  console.log('wayback', url, r.status, rows.length - 1, 'daily snapshots', rows.slice(1, 3).map(x => x[1]).join(','));
  if (rows.length > 1) {
    const ts = rows[1][1];
    const page = await fetch(`https://web.archive.org/web/${ts}id_/https://${url}`, { headers: UA });
    const html = await page.text();
    const m = html.replace(/\s+/g, ' ').match(/.{0,200}(will start|ruled out|expected to miss|minutes).{0,200}/i);
    console.log('  page', page.status, html.length, 'bytes; sample:', m?.[0]?.replace(/<[^>]+>/g, ' ').slice(0, 300));
  }
}
// FantasyPros live news page
const fp = await fetch('https://www.fantasypros.com/nba/news/', { headers: UA }); const fh = await fp.text();
console.log('fantasypros news', fp.status, fh.length, (fh.replace(/\s+/g, ' ').match(/.{0,150}(will start|ruled out|expected to miss|minutes).{0,150}/i)?.[0] ?? '').replace(/<[^>]+>/g, ' '));
const rw = await fetch('https://www.rotowire.com/basketball/news.php', { headers: UA }); const rh = await rw.text();
console.log('rotowire news', rw.status, rh.length, (rh.replace(/\s+/g, ' ').match(/.{0,150}(will start|ruled out|expected to miss|minutes).{0,150}/i)?.[0] ?? '').replace(/<[^>]+>/g, ' '));
