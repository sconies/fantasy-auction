// Preseason news for past seasons, from Wayback Machine snapshots of Rotowire player pages.
// For each season T (2022-23 = 2023 ...), take every player ESPN projected that preseason, find the last
// archived copy of his Rotowire page from 1 Sep to opening night, and keep the news notes dated between
// 1 Jul and opening night: what was known before the season, written the way live news is written.
// Usage: node scripts/fetch-archive.mjs 2023 2024 2025 2026   -> data/history/rotowire-preseason-T.json
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { normName } from '../lib/value.mjs';

const UA = { 'user-agent': 'Mozilla/5.0 (fantasy-auction research; one request per page)' };
const OPENING = { 2023: '1018', 2024: '1024', 2025: '1022', 2026: '1021' }; // opening night, MMDD of the year before T
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try { const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(45000) }); if (r.ok) return await r.text(); if (r.status === 404) return null; } catch {}
    await sleep(2000 * i);
  }
  return null;
}
const decode = s => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&#x27;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const MONTHS = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 };
const isoDate = s => { const m = /(\w+) (\d+), (\d{4})/.exec(s); return m && MONTHS[m[1]] ? `${m[3]}-${String(MONTHS[m[1]]).padStart(2, '0')}-${m[2].padStart(2, '0')}` : null; };

export function parseRotowirePage(html) {
  const out = [];
  for (const block of html.split(/<div class="news-update[ "]/).slice(1)) {
    const headline = decode(/news-update__headline">([\s\S]*?)<\/div>/.exec(block)?.[1] ?? '');
    const date = isoDate(decode(/news-update__timestamp">([\s\S]*?)<\/div>/.exec(block)?.[1] ?? ''));
    const news = decode(/news-update__news">([\s\S]*?)<\/div>/.exec(block)?.[1] ?? '');
    const analysis = decode(/news-update__analysis">([\s\S]*?)<\/div>/.exec(block)?.[1] ?? '').replace(/^ANALYSIS\s*/, '');
    if (date && news) out.push({ date, headline, text: `${headline}. ${news} ${analysis}`.trim() });
  }
  return out;
}

for (const T of process.argv.slice(2).map(Number)) {
  const Y = T - 1, open = `${Y}-${OPENING[T].slice(0, 2)}-${OPENING[T].slice(2)}`;
  const espn = JSON.parse(readFileSync(`data/history/espn-preseason-${T}.json`, 'utf8')).players;
  const wanted = new Map(espn.map(p => [normName(p.name), p.name]));
  const cdx = await get(`https://web.archive.org/cdx/search/cdx?url=www.rotowire.com/basketball/player/&matchType=prefix&from=${Y}0901&to=${Y}${OPENING[T]}&output=json&filter=statuscode:200&fl=timestamp,original&limit=50000`);
  const rows = cdx ? JSON.parse(cdx).slice(1) : [];
  const latest = new Map(); // player -> [timestamp, url]
  for (const [ts, url] of rows) {
    const slug = /\/player\/([a-z0-9-]+?)-\d+(?:[/?#]|$)/.exec(url)?.[1];
    const key = slug && normName(slug.replace(/-/g, ' '));
    if (!key || !wanted.has(key)) continue;
    if (!latest.has(key) || ts > latest.get(key)[0]) latest.set(key, [ts, url.split('?')[0]]);
  }
  const items = [];
  let pages = 0, failed = 0, i = 0;
  const todo = [...latest];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < todo.length) {
      const [key, [ts, url]] = todo[i++];
      const html = await get(`https://web.archive.org/web/${ts}id_/${url}`);
      if (!html) { failed++; continue; }
      pages++;
      for (const n of parseRotowirePage(html)) {
        if (n.date < `${Y}-07-01` || n.date >= open) continue; // offseason and preseason only
        items.push({ player: wanted.get(key), date: n.date, text: n.text.slice(0, 1200) });
      }
      await sleep(300);
    }
  }));
  const seen = new Set();
  const uniq = items.filter(it => { const k = `${it.player}|${it.text.slice(0, 120)}`; if (seen.has(k)) return false; seen.add(k); return true; });
  writeFileSync(`data/history/rotowire-preseason-${T}.json`, JSON.stringify({ season: T, window: `${Y}-07-01 to ${open}`, source: 'Wayback Machine snapshots of rotowire.com player pages', players: latest.size, pages, failed, items: uniq }) + '\n');
  console.log(`${T}: ${latest.size} of ${wanted.size} ESPN-projected players archived, ${pages} pages read (${failed} failed), ${uniq.length} preseason notes`);
}
