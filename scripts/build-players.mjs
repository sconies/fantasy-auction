// Build data/players.json: the projection the app values, plus everything needed to trust it.
//
// Projection = 75% ESPN preseason projection + 25% this app's stats model, stat by stat.
// That mix was the best of those tried in the backtest (scripts/backtest.mjs, data/eval.json).
// ESPN also supplies current teams and rookies. ESPN depth charts give each player's role.
// FantasyPros' consensus is shown next to it as a cross-check (it has no history to backtest).
// Disagreements between the sources become flags in the app and in data/qa.json.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { normName } from '../lib/value.mjs';
import { projectAll, STATS } from '../lib/project.mjs';
import { parseEspnPlayers, parseFantasyPros, depthIndex } from '../lib/sources.mjs';
import { applyFlagEffects, TARGETS } from '../lib/flag-effects.mjs';
import { FLAG_KEYS, FLAGS } from '../lib/flags.mjs';

export const ESPN_WEIGHT = 0.75;
const json = f => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);
const league = json('data/league.json');
const [last, prior] = league.projectionSeasons;
const season = last + 1;
const bbCur = json(`data/raw/bbref-${last}.json`)?.players, bbOld = json(`data/raw/bbref-${prior}.json`)?.players ?? [];
const espnRaw = json('data/sources/espn-players.json'), depthRaw = json('data/sources/espn-depth.json');
const fpHtml = existsSync('data/sources/fantasypros.html') ? readFileSync('data/sources/fantasypros.html', 'utf8') : null;
if (!bbCur || !espnRaw || !depthRaw) throw new Error('Missing inputs: run scripts/fetch-stats.mjs and scripts/fetch-sources.mjs');

const positions = json('data/positions.json') ?? {};
const extra = json('data/extra-players.json') ?? [];
const espn = parseEspnPlayers(espnRaw, season);
const fp = new Map((fpHtml ? parseFantasyPros(fpHtml) : []).map(r => [normName(r.name), r]));
const depth = depthIndex(depthRaw);
const bbById = new Map(bbCur.map(r => [r.id, r]));
const model = new Map(projectAll(bbCur, bbOld).map(p => [normName(p.name), p]));
const r1 = x => +(+x).toFixed(2);

// Jev's flags on this season's text (outlooks, injury notes, headlines, FantasyPros news): the strongest
// mention of each flag per player. The fitted effects apply only if they beat ESPN on held-out seasons.
const liveFlags = new Map(Object.entries(json('data/jev/flags.json')?.players ?? {}).map(([k, v]) => {
  const x = { has_news: 1 };
  for (const f of FLAG_KEYS) x[f] = Math.max(0, ...v.texts.map(t => t.flags?.[f] ?? 0));
  return [k, x];
}));
const effects = json('data/model/flag-effects.json');
const flagEval = json('data/eval-flags.json');
const useFlagEffects = !!(effects && flagEval?.decision?.use);
const effectsLabel = flagEval?.decision?.useFlags ? 'adjusted by fitted Jev flag effects' : 'corrected for ESPN\'s average misses';
const risk = json('data/model/risk.json');
// Yahoo's average auction cost (data/market/yahoo-auction.tsv, transcribed from Yahoo's Draft Analysis,
// salary cap tab): the market the league actually sees. ESPN's average price is kept as a fallback field.
const yahoo = new Map(existsSync('data/market/yahoo-auction.tsv') ? readFileSync('data/market/yahoo-auction.tsv', 'utf8').trim().split('\n').slice(1)
  .map(l => l.split('\t')).map(([player, rank, avg, proj, pct]) => [normName(player), { rank: +rank, avg: +avg, proj: +proj, pct: +pct }]) : []);
// Playoff weeks (18-20, mid-Feb to 21 Mar): over 2023-24..2025-26 players 32+ played 4-8% fewer games
// in them than before, under-25s 3-5% more. Those weeks decide the title, so they count a little extra.
const playoffFactor = age => (age == null ? 1 : age >= 32 ? 0.985 : age < 25 ? 1.008 : 1);

const players = [];
const seen = new Set();
for (const e of espn) {
  const key = normName(e.name);
  const m = model.get(key);
  if (!e.proj && !m) continue;
  if (e.proj && e.proj.min < 6 && !m) continue; // deep bench nobody drafts
  seen.add(key);
  const p = { id: e.espnId, name: e.name, team: e.team, injury: e.injury !== 'ACTIVE' ? e.injury : null };
  // Stat by stat: ESPN where it projects the player, the model where only it does.
  const src = e.proj && m ? 'blend' : e.proj ? 'espn' : 'model';
  for (const s of [...STATS, 'projG']) {
    p[s] = src === 'blend' ? ESPN_WEIGHT * e.proj[s] + (1 - ESPN_WEIGHT) * m[s] : (e.proj ?? m)[s];
    p[s] = s === 'projG' ? Math.round(p[s]) : r1(p[s]);
  }
  const x = liveFlags.get(key) ?? null;
  if (x) p.jevFlags = Object.fromEntries(FLAG_KEYS.filter(k => x[k] >= 0.5).map(k => [k, +x[k].toFixed(2)]));
  if (useFlagEffects) {
    const before = { ...p };
    Object.assign(p, applyFlagEffects(p, x, effects.model));
    p.flagEffect = { games: p.projG - before.projG, min: r1(p.min - before.min), pts: r1(p.pts - before.pts), reb: r1(p.reb - before.reb), ast: r1(p.ast - before.ast),
      tpm: r1(p.tpm - before.tpm), stl: r1(p.stl - before.stl), blk: r1(p.blk - before.blk), tov: r1(p.tov - before.tov) };
    for (const s of STATS) p[s] = r1(p[s]);
  }
  if (risk) p.risk = riskTier(x);
  const f = fp.get(key), d = depth.get(e.espnId), bb = m && bbById.get(m.id);
  p.pos = positions[e.espnId] ?? (f?.pos?.length ? f.pos : e.pos.length ? e.pos : (m ? [bb?.pos].filter(Boolean) : []));
  p.age = m?.age ?? null;
  p.playoffFactor = playoffFactor(p.age);
  p.depth = d ? { pos: d.pos, rank: d.rank, starter: d.starter } : null;
  const y = yahoo.get(key);
  p.marketEspn = e.market.espnAvgAuction ? +e.market.espnAvgAuction.toFixed(1) : null;
  p.market = yahoo.size ? (y ? y.avg : null) : p.marketEspn;
  p.marketSource = yahoo.size ? 'Yahoo average auction cost' : 'ESPN average auction price';
  if (y) p.yahoo = y;
  p.outlook = e.outlook ?? null;
  p.source = src;
  p.sources = {
    espn: e.proj ? { g: e.proj.projG, min: r1(e.proj.min), pts: r1(e.proj.pts), reb: r1(e.proj.reb), ast: r1(e.proj.ast) } : null,
    model: m ? { g: m.projG, min: r1(m.min), pts: r1(m.pts), reb: r1(m.reb), ast: r1(m.ast) } : null,
    fp: f ? { g: f.projG, min: r1(f.min), pts: r1(f.pts), reb: r1(f.reb), ast: r1(f.ast) } : null,
  };
  if (bb) p.hist = { [last]: { g: bb.g, min: bb.min, pts: bb.pts, team: bb.team } };
  p.flags = flags(p, e, m, f, d, bb);
  p.notes = p.flags.filter(x => /^(New team|No NBA stats|Too few minutes)/.test(x));
  p.flags = p.flags.filter(x => !p.notes.includes(x));
  players.push(p);
}
// Anyone the stats model projects but ESPN doesn't list at all (rare: usually unsigned veterans).
for (const [key, m] of model) {
  if (seen.has(key) || m.min < 20) continue;
  players.push({ ...m, pos: positions[m.id] ?? [bbById.get(m.id)?.pos].filter(Boolean), source: 'model', depth: null, market: null,
    flags: ['Not on an ESPN roster: unsigned or overseas? Projection is last seasons only.'] });
}
for (const x of extra) players.push({ projG: 70, source: 'manual', flags: [], ...x });

// Risk tier from the flags, with the dollar range measured for that tier in the backtest (data/model/risk.json).
function riskTier(x) {
  const hit = t => !t.anyOf.length || t.anyOf.some(f => (x?.[f] ?? 0) >= t.threshold);
  const t = risk.tiers.find(hit) ?? risk.tiers[risk.tiers.length - 1];
  return { tier: t.name, low: t.low, high: t.high };
}
function flags(p, e, m, f, d, bb) {
  const out = [];
  if (!m) out.push(e.last ? 'Too few minutes last season for the stats model: projection is ESPN only.' : 'No NBA stats yet (rookie or returning from abroad): projection is ESPN only.');
  if (bb && bb.team && p.team && !/^\d?TM$|^TOT$/.test(bb.team) && bb.team !== p.team && !(bb.team === 'CHO' && p.team === 'CHA') && !(bb.team === 'BRK' && p.team === 'BKN') && !(bb.team === 'PHO' && p.team === 'PHX'))
    out.push(`New team: ${bb.team} → ${p.team}. Role is a guess until he plays.`);
  if (!d && p.min >= 15) out.push('Not on his team\'s ESPN depth chart.');
  if (d?.starter && p.min < 24) out.push(`Listed starter at ${d.pos} but projected only ${p.min.toFixed(0)} min.`);
  if (d && d.rank >= 3 && p.min >= 26) out.push(`Third string or lower at ${d.pos} on the depth chart, yet projected ${p.min.toFixed(0)} min.`);
  if (f && Math.abs(f.min - p.min) >= 4) out.push(`FantasyPros consensus has ${f.min.toFixed(0)} min, we have ${p.min.toFixed(0)}.`);
  if (f && Math.abs(f.projG - p.projG) >= 12) out.push(`FantasyPros consensus has ${f.projG} games, we have ${p.projG}.`);
  if (e.proj && m && Math.abs(e.proj.min - m.min) >= 6) out.push(`ESPN projects ${e.proj.min.toFixed(0)} min, his recent seasons say ${m.min.toFixed(0)}: role change.`);
  return out;
}

// Data health, for the app and for the job to fail on.
const top = [...players].sort((a, b) => (b.market ?? 0) - (a.market ?? 0)).slice(0, 200);
const qa = {
  builtAt: new Date().toISOString(),
  counts: {
    players: players.length, espnProjected: espn.filter(e => e.proj).length, fantasyPros: fp.size, depthChartPlayers: depth.size,
    blended: players.filter(p => p.source === 'blend').length, espnOnly: players.filter(p => p.source === 'espn').length, modelOnly: players.filter(p => p.source === 'model').length,
    flagged: players.filter(p => p.flags.length).length, newTeam: players.filter(p => p.notes?.some(n => n.startsWith('New team'))).length,
  },
  top200MissingFantasyPros: top.filter(p => !fp.has(normName(p.name))).map(p => p.name).slice(0, 40),
  top200MissingDepth: top.filter(p => !p.depth).map(p => p.name),
  starters: players.filter(p => p.depth?.starter).length,
};
const problems = [];
if (qa.counts.espnProjected < 250) problems.push(`ESPN projected only ${qa.counts.espnProjected} players`);
if (qa.counts.depthChartPlayers < 400) problems.push(`depth charts cover only ${qa.counts.depthChartPlayers} players`);
if (qa.starters < 140) problems.push(`only ${qa.starters} starters on depth charts`);
qa.problems = problems;

// Big projection moves since the last build (ESPN updates its projections through preseason).
const old = new Map((json('data/players.json')?.players ?? []).map(q => [q.id, q]));
{
  const log = json('data/projection-changes.json') ?? { changes: [] };
  const today = new Date().toISOString().slice(0, 10);
  for (const p of players) {
    const o = old.get(p.id);
    if (!o) continue;
    const parts = [];
    if (Math.abs(p.min - o.min) >= 2) parts.push(`minutes ${o.min.toFixed(1)} → ${p.min.toFixed(1)}`);
    if (Math.abs(p.projG - o.projG) >= 8) parts.push(`games ${o.projG} → ${p.projG}`);
    if (o.team && p.team && o.team !== p.team) parts.push(`team ${o.team} → ${p.team}`);
    if (parts.length) log.changes.push({ date: today, playerId: p.id, name: p.name, team: p.team, summary: parts.join(', ') });
  }
  log.changes = log.changes.slice(-400);
  writeFileSync('data/projection-changes.json', JSON.stringify(log, null, 1) + '\n');
}
writeFileSync('data/players.json', JSON.stringify({ builtAt: qa.builtAt, season, method: `${ESPN_WEIGHT * 100}% ESPN projection + ${100 - ESPN_WEIGHT * 100}% stats model${useFlagEffects ? `, ${effectsLabel}` : ''}`, flagEffects: useFlagEffects, players }) + '\n');
writeFileSync('data/qa.json', JSON.stringify(qa, null, 1) + '\n');
// Role changes: compare with the depth charts from the previous run and log who moved in or out of the lineup.
const before = json('data/depth.json')?.players ?? null;
if (before) {
  const log = json('data/role-changes.json') ?? { changes: [] };
  const today = new Date().toISOString().slice(0, 10);
  for (const p of players) {
    const was = before[p.id], now = p.depth;
    if (!was || !now) continue;
    if (was.starter !== now.starter || (was.rank !== now.rank && Math.min(was.rank, now.rank) <= 2))
      log.changes.push({ date: today, playerId: p.id, name: p.name, team: p.team, from: `${was.pos} #${was.rank}`, to: `${now.pos} #${now.rank}`,
        promoted: now.rank < was.rank, projectedMin: p.min });
  }
  log.changes = log.changes.slice(-300);
  writeFileSync('data/role-changes.json', JSON.stringify(log, null, 1) + '\n');
}
// Keep the depth charts so the next run can report who moved up or down.
writeFileSync('data/depth.json', JSON.stringify({ fetchedAt: depthRaw.fetchedAt, players: Object.fromEntries([...depth].map(([id, d]) => [id, d])) }) + '\n');
console.log(`${players.length} players (${qa.counts.blended} blended, ${qa.counts.espnOnly} ESPN only, ${qa.counts.modelOnly} model only), ${qa.counts.flagged} flagged`);
if (problems.length) { console.error('DATA PROBLEMS: ' + problems.join('; ')); process.exit(1); }
