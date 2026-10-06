// Diagnostic: how much archived preseason player text exists on the Wayback Machine. Not part of the data job.
const UA = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' };
const cdx = async (url, match, from, to) => {
  const q = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&matchType=${match}&from=${from}&to=${to}&output=json&filter=statuscode:200&fl=timestamp,original&limit=20000`;
  for (let i = 0; i < 3; i++) { try { const r = await fetch(q, { headers: UA, signal: AbortSignal.timeout(60000) }); if (r.ok) return (await r.json()).slice(1); } catch {} await new Promise(r => setTimeout(r, 4000)); }
  return null;
};
for (const yr of [2022, 2023, 2024, 2025]) {
  const from = `${yr}0901`, to = `${yr}1022`;
  const targets = [
    ['cbs news all (any page)', 'www.cbssports.com/fantasy/basketball/players/news/', 'prefix'],
    ['cbs player pages', 'www.cbssports.com/nba/players/', 'prefix'],
    ['rotowire player pages', 'www.rotowire.com/basketball/player/', 'prefix'],
    ['fantasypros nba news', 'www.fantasypros.com/nba/news/', 'prefix'],
    ['fantasypros player news', 'www.fantasypros.com/nba/players/', 'prefix'],
  ];
  for (const [label, url, m] of targets) {
    const rows = await cdx(url, m, from, to);
    const uniq = rows ? new Set(rows.map(r => r[1].split('?')[0])).size : null;
    console.log(yr, label, rows ? `${rows.length} captures, ${uniq} distinct pages, e.g. ${rows.slice(0, 2).map(r => r[1]).join(' ')}` : 'CDX failed');
  }
}
// What does a CBS player page hold?
const rows = await cdx('www.cbssports.com/nba/players/', 'prefix', '20240901', '20241022');
const pick = rows?.find(r => /\/nba\/players\/\d+\//.test(r[1]));
if (pick) {
  const html = await (await fetch(`https://web.archive.org/web/${pick[0]}id_/${pick[1]}`, { headers: UA })).text();
  const t = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  console.log('CBS player page', pick[1], html.length, t.match(/.{0,100}(Fantasy|outlook|Outlook|Latest).{0,500}/)?.[0]);
}
