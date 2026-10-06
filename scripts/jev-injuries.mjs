// Jev (TypeSafe) reads injury notes and says how much of the 2026-27 regular season each one implies.
// ESPN's return dates drive the app's "games missed" proposals; Jev reads the words, which catches
// the cases a date gets wrong: a season-ending injury with a placeholder date, a note about last season,
// an "out indefinitely" with a date two weeks away. Informational: it adds a check to a proposal, never
// changes a value by itself. Tested first (--test) against hand labels in data/jev/injury-labels.json.
//
//   node scripts/jev-injuries.mjs --test --if-key   accuracy on the labelled notes -> data/jev/test-injuries.json
//   node scripts/jev-injuries.mjs --run --if-key    read the current notes in data/news.json -> data/jev/injuries.json
//
// The key comes from the environment only (TYPESAFE_API_KEY, a GitHub Actions secret), never a file or an argument.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const API_URL = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';
const argv = process.argv.slice(2);
const key = (process.env.TYPESAFE_API_KEY || '').trim();
const labels = JSON.parse(readFileSync('data/jev/injury-labels.json', 'utf8'));
const OPTIONS = labels.options;
mkdirSync('data/jev', { recursive: true });

if (!key) {
  if (argv.includes('--if-key')) { console.log(JSON.stringify({ jev: 'skipped', reason: 'no TYPESAFE_API_KEY in this environment' })); process.exit(0); }
  console.error('Needs TYPESAFE_API_KEY in the environment (or --if-key to skip quietly). Nothing sent.'); process.exit(1);
}

const question = {
  absence: {
    type: 'choice',
    instructions: 'The text in `note` is a news note about an NBA player. The 2026-27 regular season starts on 20 October 2026 and the note was written on the date in `written`. Going only by what the note says, how much of the 2026-27 regular season will the player miss?',
    criteria: OPTIONS,
  },
};

async function ask(state) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(API_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, model: MODEL, questions: question }), signal: AbortSignal.timeout(60000) });
      if (res.ok) { const a = (await res.json()).answers?.absence; return { choice: a?.choice ?? null, confidence: a?.confidence ?? null }; }
      if ([429, 502, 503, 504, 529].includes(res.status)) { await new Promise(r => setTimeout(r, 1000 * 2 ** attempt)); continue; }
      throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 120).split(key).join('[redacted]')}`);
    } catch (e) { if (attempt === 5 || /^HTTP/.test(e.message)) throw e; await new Promise(r => setTimeout(r, 1000 * 2 ** attempt)); }
  }
}
const pool = async (items, fn, n = 4) => { let i = 0; const out = []; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } })); return out; };
const written = d => (d ? String(d).slice(0, 10) : '2026-10-06');

if (argv.includes('--test')) {
  const answers = await pool(labels.items, it => ask({ note: it.text, written: written(it.date) }));
  const rows = labels.items.map((it, k) => ({ name: it.name, label: it.label, jev: answers[k].choice, confidence: answers[k].confidence, ambiguous: it.ambiguous, constructed: !!it.constructed, text: it.text }));
  const acc = rs => rs.length ? +(rs.filter(r => r.jev === r.label).length / rs.length).toFixed(3) : null;
  const clear = rows.filter(r => !r.ambiguous);
  const perOption = Object.fromEntries(Object.keys(OPTIONS).map(o => {
    const said = clear.filter(r => r.jev === o), truth = clear.filter(r => r.label === o);
    return [o, { examples: truth.length, precision: said.length ? +(said.filter(r => r.label === o).length / said.length).toFixed(3) : null, recall: truth.length ? +(truth.filter(r => r.jev === o).length / truth.length).toFixed(3) : null }];
  }));
  // The decision that matters: would we tell the app to expect missed regular-season games?
  const long = r => ['weeks', 'months', 'season'].includes(r);
  const bin = { tp: clear.filter(r => long(r.label) && long(r.jev)).length, fp: clear.filter(r => !long(r.label) && long(r.jev)).length, fn: clear.filter(r => long(r.label) && !long(r.jev)).length };
  const out = { testedOn: new Date().toISOString().slice(0, 10), model: MODEL, accuracyClear: acc(clear), accuracyReal: acc(clear.filter(r => !r.constructed)), accuracyConstructed: acc(clear.filter(r => r.constructed)), accuracyAmbiguous: acc(rows.filter(r => r.ambiguous)), missesGames: bin, perOption, wrong: clear.filter(r => r.jev !== r.label).map(r => ({ name: r.name, label: r.label, jev: r.jev, confidence: r.confidence, text: r.text.slice(0, 160) })) };
  writeFileSync('data/jev/test-injuries.json', JSON.stringify(out, null, 1) + '\n');
  console.log(JSON.stringify({ accuracyClear: out.accuracyClear, accuracyReal: out.accuracyReal, accuracyConstructed: out.accuracyConstructed, accuracyAmbiguous: out.accuracyAmbiguous, missesGames: bin, perOption }, null, 1));
}

if (argv.includes('--run')) {
  const news = JSON.parse(readFileSync('data/news.json', 'utf8'));
  const prevFile = 'data/jev/injuries.json';
  const prev = existsSync(prevFile) ? JSON.parse(readFileSync(prevFile, 'utf8')).notes ?? {} : {};
  const hash = i => createHash('sha1').update(`${i.name}|${i.comment}`).digest('hex').slice(0, 16);
  const todo = (news.injuries ?? []).filter(i => i.comment && !prev[hash(i)]);
  const answers = await pool(todo, i => ask({ note: i.comment, written: written(i.date) }));
  const notes = {};
  for (const i of news.injuries ?? []) { const h = hash(i); const k = todo.indexOf(i); notes[h] = k >= 0 ? { name: i.name, ...answers[k] } : prev[h]; }
  writeFileSync(prevFile, JSON.stringify({ readAt: new Date().toISOString(), model: MODEL, notes }, null, 1) + '\n');
  console.log(JSON.stringify({ jev: 'read', notes: Object.keys(notes).length, asked: todo.length }));
}
