// Fetch NBA injuries and headlines from ESPN's public site API into data/news.json.
import { writeFileSync } from 'node:fs';

const get = async url => {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (fantasy-auction news job)' } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
};

const inj = await get('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries');
const injuries = [];
for (const team of inj.injuries ?? []) {
  for (const i of team.injuries ?? []) {
    injuries.push({
      name: i.athlete?.displayName,
      team: team.displayName ?? i.athlete?.team?.abbreviation,
      status: i.status ?? i.type?.description,
      comment: i.shortComment ?? i.longComment ?? '',
      date: i.date,
      returnDate: i.details?.returnDate ?? null,
      injury: [i.details?.type, i.details?.detail].filter(Boolean).join(' – '),
    });
  }
}

const news = await get('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news?limit=100');
const articles = (news.articles ?? []).map(a => ({
  headline: a.headline,
  description: a.description,
  published: a.published,
  url: a.links?.web?.href,
  athletes: (a.categories ?? []).filter(c => c.type === 'athlete').map(c => c.description ?? c.athlete?.description).filter(Boolean),
}));

writeFileSync('data/news.json', JSON.stringify({ fetchedAt: new Date().toISOString(), injuries, articles }, null, 1) + '\n');
console.log(`${injuries.length} injuries, ${articles.length} articles`);
