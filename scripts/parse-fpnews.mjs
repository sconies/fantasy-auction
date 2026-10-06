// FantasyPros NBA player news (data/sources/fantasypros-news.html, fetched by fetch-sources.mjs)
// -> data/sources/fantasypros-news.json: [{ player, date, text, url }].
// Missing or changed page: writes an empty list and says so, rather than failing the whole refresh.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const f = 'data/sources/fantasypros-news.html';
const decode = s => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&#x27;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
// "Mon, Oct 5th 10:13pm EDT" has no year: take the latest year that doesn't put it in the future.
function isoDate(s, now = new Date()) {
  const m = /(\w{3}) (\d{1,2})(?:st|nd|rd|th)/.exec(s ?? '');
  if (!m || !MON[m[1]]) return null;
  let y = now.getUTCFullYear();
  const d = () => `${y}-${String(MON[m[1]]).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  if (new Date(d()) > new Date(now.getTime() + 2 * 864e5)) y--;
  return d();
}

export function parseFantasyProsNews(html) {
  const items = [];
  for (const b of html.split('<div class="player-news-item">').slice(1)) {
    const block = b.split('fp-vote-container')[0];
    const player = decode(/<img[^>]+alt="([^"]+)"/.exec(block)?.[1] ?? '');
    const link = /<a href="(\/nba\/news\/\d+\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    const headline = decode(link?.[2] ?? '');
    const date = isoDate(/<p>(\w{3}, \w{3} \d{1,2}\w{2} [^<]*)<br>/.exec(block)?.[1]);
    const paras = [...block.matchAll(/<p>([\s\S]*?)<\/p>/g)].map(m => decode(m[1]))
      .filter(t => t.length > 30 && !/^Category:/.test(t) && !/^\w{3}, \w{3} \d/.test(t));
    const text = [headline, ...paras].join(' ').replace(/\(Source: [^)]*\)/g, '').trim();
    if (player && text.length > 60) items.push({ player, date, headline, text: text.slice(0, 1200), url: link ? `https://www.fantasypros.com${link[1]}` : null });
  }
  return items;
}

const html = existsSync(f) ? readFileSync(f, 'utf8') : '';
const seen = new Set();
const items = (html ? parseFantasyProsNews(html) : []).filter(i => { const k = i.url ?? `${i.player}|${i.headline}`; if (seen.has(k)) return false; seen.add(k); return true; });
writeFileSync('data/sources/fantasypros-news.json', JSON.stringify({ parsedAt: new Date().toISOString(), items }) + '\n');
console.log(JSON.stringify({ fantasyprosNews: items.length, note: html ? (items.length ? 'ok' : 'page fetched but no items recognised: check the parser') : 'no page' }));
