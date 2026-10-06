// Jev reads player text and answers every flag in lib/flags.mjs (one request per text, ~30 questions).
// Texts: ESPN season outlooks, ESPN injury notes, ESPN headlines, FantasyPros player news.
// Each text is cached by its content hash, so a refresh only pays for text that is new or rewritten.
//
//   node scripts/jev-flags.mjs --live --if-key          -> data/jev/flags.json (current season)
//   node scripts/jev-flags.mjs --history <file> --if-key   flag a historical text file (see fit-flags.mjs)
//   node scripts/jev-flags.mjs --test --if-key          reading accuracy on data/jev/flag-labels.json
//
// Key from the environment only (TYPESAFE_API_KEY).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { FLAG_KEYS, jevQuestions } from '../lib/flags.mjs';
import { normName } from '../lib/value.mjs';

const API_URL = 'https://api.typesafe.ai/v1/systemone', MODEL = 'jev-latest';
const argv = process.argv.slice(2);
const arg = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const key = (process.env.TYPESAFE_API_KEY || '').trim();
const json = f => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);
mkdirSync('data/jev', { recursive: true });
if (!key) {
  if (argv.includes('--if-key')) { console.log(JSON.stringify({ jev: 'skipped', reason: 'no key' })); process.exit(0); }
  console.error('Needs TYPESAFE_API_KEY. Nothing sent.'); process.exit(1);
}

const QUESTIONS = jevQuestions();
// Live and historical runs keep separate caches so the two workflows never edit the same file.
const CACHE_FILE = arg('--history') ? 'data/jev/flag-cache-history.json' : 'data/jev/flag-cache.json';
const cache = json(CACHE_FILE) ?? {};
const hashOf = (player, text) => createHash('sha1').update(`${player}|${text}`).digest('hex').slice(0, 16);

async function ask(player, text) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(API_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: { player, text: text.slice(0, 3000) }, model: MODEL, questions: QUESTIONS }), signal: AbortSignal.timeout(60000) });
      if (res.ok) {
        const a = (await res.json()).answers ?? {};
        const out = {};
        for (const k of FLAG_KEYS) if (typeof a[k]?.noul === 'number') out[k] = Math.round(a[k].noul * 1000) / 1000;
        if (Object.keys(out).length < FLAG_KEYS.length) throw new Error('incomplete answer');
        return out;
      }
      if ([429, 502, 503, 504, 529].includes(res.status)) { await new Promise(r => setTimeout(r, 1000 * 2 ** attempt)); continue; }
      throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 120).split(key).join('[redacted]')}`);
    } catch (e) { if (attempt === 5 || /^HTTP/.test(e.message)) throw e; await new Promise(r => setTimeout(r, 1000 * 2 ** attempt)); }
  }
}

// Flag a list of { player, text, ... } items, using the cache; returns items with .flags.
export async function flagItems(items, concurrency = 6) {
  const todo = items.filter(it => it.text && it.text.length >= 40 && !cache[hashOf(it.player, it.text)]);
  let i = 0, failed = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < todo.length) {
      const it = todo[i++];
      try { cache[hashOf(it.player, it.text)] = await ask(it.player, it.text); } catch (e) { failed++; if (failed > 20) throw e; }
    }
  }));
  writeFileSync(CACHE_FILE, JSON.stringify(cache) + '\n');
  console.log(JSON.stringify({ jev: 'flagged', items: items.length, asked: todo.length, failed }));
  return items.map(it => ({ ...it, flags: cache[hashOf(it.player, it.text)] ?? null }));
}

// Current-season texts from the files the data job already fetched.
function liveItems() {
  const items = [];
  const espn = json('data/sources/espn-players.json');
  for (const { player: p } of espn?.players ?? []) if (p.seasonOutlook) items.push({ player: p.fullName, kind: 'outlook', text: p.seasonOutlook, date: null });
  const news = json('data/news.json') ?? {};
  for (const i of news.injuries ?? []) items.push({ player: i.name, kind: 'injury', text: i.comment, date: i.date });
  for (const a of news.articles ?? []) for (const n of a.athletes ?? []) items.push({ player: n, kind: 'headline', text: `${a.headline}. ${a.description ?? ''}`, date: a.published, url: a.url });
  for (const n of json('data/sources/fantasypros-news.json')?.items ?? []) items.push({ player: n.player, kind: 'news', text: n.text, date: n.date, url: n.url });
  return items;
}

if (argv.includes('--live')) {
  const flagged = await flagItems(liveItems());
  // Per player: every flagged text, newest first; the app shows them and fit-flags' effects size them.
  const players = {};
  for (const it of flagged) {
    if (!it.flags) continue;
    const k = normName(it.player);
    (players[k] ??= { name: it.player, texts: [] }).texts.push({ kind: it.kind, date: it.date, url: it.url, text: it.text.slice(0, 400), flags: it.flags });
  }
  for (const p of Object.values(players)) p.texts.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
  writeFileSync('data/jev/flags.json', JSON.stringify({ readAt: new Date().toISOString(), model: MODEL, players }) + '\n');
}

if (arg('--history')) {
  const f = arg('--history');
  const data = json(f);
  const flagged = await flagItems(data.items);
  writeFileSync(f.replace(/\.json$/, '.flags.json'), JSON.stringify({ ...data, model: MODEL, items: flagged }) + '\n');
}

if (argv.includes('--test')) {
  const labels = json('data/jev/flag-labels.json');
  const flagged = await flagItems(labels.items.map(it => ({ player: it.player, text: it.text })));
  const per = {};
  for (const k of FLAG_KEYS) {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    labels.items.forEach((it, i) => {
      if (!(k in it.labels)) return;
      const yes = it.labels[k], said = (flagged[i].flags?.[k] ?? 0) >= 0.5;
      if (yes && said) tp++; else if (!yes && said) fp++; else if (yes && !said) fn++; else tn++;
    });
    per[k] = { yes: tp + fn, no: fp + tn, precision: tp + fp ? +(tp / (tp + fp)).toFixed(3) : null, recall: tp + fn ? +(tp / (tp + fn)).toFixed(3) : null, accuracy: +((tp + tn) / Math.max(1, tp + fp + fn + tn)).toFixed(3) };
  }
  const all = Object.values(per).reduce((s, v) => s + v.accuracy * (v.yes + v.no), 0) / Object.values(per).reduce((s, v) => s + v.yes + v.no, 0);
  writeFileSync('data/jev/test-flags.json', JSON.stringify({ testedOn: new Date().toISOString().slice(0, 10), model: MODEL, overallAccuracy: +all.toFixed(3), perFlag: per }, null, 1) + '\n');
  console.log(JSON.stringify({ overallAccuracy: all, perFlag: per }, null, 1));
}
