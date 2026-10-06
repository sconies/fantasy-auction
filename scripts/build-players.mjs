// Build next season's per-game projections (data/players.json) from the raw season files.
// Projection = recent seasons blended by games played, an age nudge, and a games-played estimate.
// Yahoo eligibility comes from data/positions.json where set, else from Basketball Reference's position.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const read = f => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);
const league = read('data/league.json');
const last = league.projectionSeasons[0], prior = league.projectionSeasons[1];
const cur = read(`data/raw/bbref-${last}.json`), old = read(`data/raw/bbref-${prior}.json`);
if (!cur) throw new Error(`data/raw/bbref-${last}.json is missing; run scripts/fetch-stats.mjs`);
const positions = read('data/positions.json') ?? {};
const extra = read('data/extra-players.json') ?? []; // rookies and anyone else without NBA stats

const STATS = ['min', 'fgm', 'fga', 'ftm', 'fta', 'tpm', 'pts', 'reb', 'ast', 'stl', 'blk', 'tov'];
const oldById = new Map((old?.players ?? []).map(p => [p.id, p]));
const ageNudge = age => (age <= 21 ? 1.07 : age <= 23 ? 1.04 : age <= 25 ? 1.02 : age <= 29 ? 1 : age <= 31 ? 0.98 : age <= 33 ? 0.95 : 0.91);
const basePos = s => [...new Set(String(s).split(/[-,/ ]+/).filter(x => ['PG', 'SG', 'SF', 'PF', 'C'].includes(x)))];

const players = [];
for (const c of cur.players) {
  const o = oldById.get(c.id);
  // Weight each season by games played, the older one at half strength.
  const wc = c.g, wo = o ? o.g * 0.5 : 0;
  const blend = k => (c[k] * wc + (o ? o[k] * wo : 0)) / (wc + wo || 1);
  const age = c.age + 1;
  const nudge = ageNudge(age);
  const p = { id: c.id, name: c.name, team: c.team, age, pos: positions[c.id] ?? basePos(c.pos) };
  for (const k of STATS) p[k] = +(blend(k) * (k === 'min' ? 1 : nudge)).toFixed(2);
  // Games: regress recent availability toward 70 (a typical healthy season).
  const gHist = o ? 0.65 * c.g + 0.35 * o.g : c.g;
  p.projG = Math.round(Math.min(78, 0.7 * gHist + 0.3 * 70));
  p.hist = { [last]: { g: c.g, min: c.min, pts: c.pts }, ...(o ? { [prior]: { g: o.g, min: o.min, pts: o.pts } } : {}) };
  if (p.min >= 12 && c.g + (o?.g ?? 0) >= 15) players.push(p);
}
for (const e of extra) players.push({ projG: 70, ...e, pos: positions[e.id] ?? e.pos });

writeFileSync('data/players.json', JSON.stringify({ builtAt: new Date().toISOString(), seasons: [last, prior], players }, null, 0) + '\n');
console.log(`${players.length} players projected`);
