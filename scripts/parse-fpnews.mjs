// FantasyPros NBA player news (data/sources/fantasypros-news.html, fetched by fetch-sources.mjs)
// -> data/sources/fantasypros-news.json: [{ player, date, text, url }].
// Missing or changed page: writes an empty list and says so, rather than failing the whole refresh.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const f = 'data/sources/fantasypros-news.html';
const decode = s => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&#x27;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

export function parseFantasyProsNews(html) {
  const items = [];
  // Each news item links its player (fp-player-name="...") and carries a headline, the news and a "Fantasy Impact".
  const blocks = html.split(/<div class="player-news-item[^"]*"|<article[^>]*class="[^"]*news[^"]*"/).slice(1);
  for (const b of blocks) {
    const player = /fp-player-name="([^"]+)"/.exec(b)?.[1] ?? decode(/class="[^"]*player-name[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(b)?.[1] ?? '');
    const text = decode(b.slice(0, 6000).replace(/<script[\s\S]*?<\/script>/g, ''));
    const date = /datetime="([^"]+)"/.exec(b)?.[1] ?? /(\w{3} \d{1,2}, \d{4})/.exec(text)?.[1] ?? null;
    const url = /href="(\/nba\/news\/\d+\/[^"]+)"/.exec(b)?.[1];
    if (player && text.length > 60) items.push({ player, date, text: text.slice(0, 1200), url: url ? `https://www.fantasypros.com${url}` : null });
  }
  return items;
}

const html = existsSync(f) ? readFileSync(f, 'utf8') : '';
const items = html ? parseFantasyProsNews(html) : [];
writeFileSync('data/sources/fantasypros-news.json', JSON.stringify({ parsedAt: new Date().toISOString(), items }) + '\n');
console.log(JSON.stringify({ fantasyprosNews: items.length, note: html ? (items.length ? 'ok' : 'page fetched but no items recognised: check the parser') : 'no page' }));
