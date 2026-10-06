// Diagnostic: layout of an archived Rotowire player page. Not part of the data job.
const UA = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' };
const q = 'https://web.archive.org/cdx/search/cdx?url=www.rotowire.com/basketball/player/&matchType=prefix&from=20241001&to=20241022&output=json&filter=statuscode:200&fl=timestamp,original&limit=50';
const rows = (await (await fetch(q, { headers: UA })).json()).slice(1);
for (const [ts, url] of rows.filter(r => !r[1].includes('?')).slice(0, 2)) {
  const html = await (await fetch(`https://web.archive.org/web/${ts}id_/${url}`, { headers: UA })).text();
  console.log('\n=====', ts, url, html.length);
  const classes = {}; for (const m of html.matchAll(/class="([^"]*news[^"]*)"/gi)) classes[m[1]] = (classes[m[1]] || 0) + 1;
  console.log('news classes', JSON.stringify(classes));
  const i = html.search(/class="[^"]*news-update[^"]*"/i);
  console.log('block', i, html.slice(Math.max(0, i - 200), i + 2500).replace(/\s+/g, ' '));
  const j = html.search(/Outlook|outlook/);
  console.log('outlook', j, html.slice(Math.max(0, j - 200), j + 800).replace(/\s+/g, ' ').replace(/<[^>]+>/g, '|'));
}
