// Turn a refresh into a short list of things that may need a decision: data/signals.json.
//
//   text     a new note (injury, headline, FantasyPros news) where Jev flags something material
//   outlook  ESPN rewrote a player's season outlook (its flags feed the fitted effects automatically)
//   depth    a depth chart move into or out of the starting lineup
//   change   ESPN's projection moved a lot (minutes or games)
//
// `judge: true` marks what the Claude news job (jobs/news.md) should size into a proposal; the rest is
// shown in the app for information. Signals keep their status across runs ('new' until handled).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { normName } from '../lib/value.mjs';
import { FLAGS } from '../lib/flags.mjs';

const json = (f, d = null) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d);
const today = new Date().toISOString().slice(0, 10);
const players = json('data/players.json', { players: [] }).players;
const byName = new Map(players.map(p => [normName(p.name), p]));
const relevant = p => p && (p.min >= 15 || (p.market ?? 0) >= 1);
const prev = json('data/signals.json', { signals: [] });
const known = new Map(prev.signals.map(s => [s.id, s]));
const out = [];
const add = s => { const old = known.get(s.id); out.push(old ? { ...s, status: old.status, firstSeen: old.firstSeen, handledNote: old.handledNote } : { ...s, status: 'new', firstSeen: today }); };
const hash = s => createHash('sha1').update(s).digest('hex').slice(0, 12);

// Flags that mean the player's season may have changed, and need a judgement when they appear in news.
const MATERIAL = ['absence', 'recovering', 'minutes_limit', 'load_managed', 'starter', 'bench', 'role_up', 'role_down', 'out_of_rotation', 'new_team', 'opening', 'crowded', 'usage_up', 'playmaker'];
const flagged = json('data/jev/flags.json', { players: {} }).players;
for (const [k, entry] of Object.entries(flagged)) {
  const p = byName.get(k);
  if (!relevant(p)) continue;
  for (const t of entry.texts) {
    const hits = MATERIAL.filter(f => (t.flags?.[f] ?? 0) >= 0.7);
    if (!hits.length) continue;
    const isOutlook = t.kind === 'outlook';
    add({ id: `${t.kind}:${hash(p.name + t.text)}`, kind: isOutlook ? 'outlook' : 'text', playerId: p.id, name: p.name, team: p.team,
      date: t.date ?? today, source: t.kind, url: t.url ?? null, text: t.text,
      flags: Object.fromEntries(hits.map(f => [f, t.flags[f]])), summary: hits.map(f => FLAGS[f].q.replace(/^says (the player )?/, '')).join('; '),
      judge: !isOutlook });
  }
}
for (const c of json('data/role-changes.json', { changes: [] }).changes.filter(c => c.date === today)) {
  const p = players.find(x => x.id === c.playerId);
  if (!relevant(p)) continue;
  add({ id: `depth:${c.playerId}:${c.date}:${c.to}`, kind: 'depth', playerId: c.playerId, name: c.name, team: c.team, date: c.date,
    summary: `Depth chart ${c.from} → ${c.to}`, judge: c.promoted !== undefined && (c.to.endsWith('#1') || c.from.endsWith('#1')) });
}
for (const c of json('data/projection-changes.json', { changes: [] }).changes.filter(c => c.date === today)) {
  const p = players.find(x => x.id === c.playerId);
  if (!relevant(p)) continue;
  add({ id: `change:${c.playerId}:${c.date}`, kind: 'change', playerId: c.playerId, name: c.name, team: c.team, date: c.date, summary: c.summary, judge: false });
}
// Keep handled signals for two weeks so the app can show what was done.
const cutoff = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
for (const s of prev.signals) if (!out.some(o => o.id === s.id) && s.firstSeen >= cutoff) out.push(s);
out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
const counts = { new: out.filter(s => s.status === 'new').length, toJudge: out.filter(s => s.status === 'new' && s.judge).length };
writeFileSync('data/signals.json', JSON.stringify({ builtAt: new Date().toISOString(), counts, signals: out }, null, 1) + '\n');
console.log(JSON.stringify({ signals: out.length, ...counts }));
