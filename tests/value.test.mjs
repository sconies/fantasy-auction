import test from 'node:test';
import assert from 'node:assert/strict';
import { computeValues, draftState, applyAdjustments, DEFAULT_LEAGUE, normName } from '../lib/value.mjs';
import { parsePerGame } from '../scripts/bbref-parse.mjs';

// A deterministic fake league of 400 players with a spread of skill.
function fakePlayers(n = 400) {
  let seed = 7;
  const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  return Array.from({ length: n }, (_, i) => {
    const s = 1 - i / n; // better players first
    const min = 14 + 22 * s;
    const fga = (5 + 14 * s) * (0.8 + 0.4 * r()), fta = (1 + 6 * s) * (0.6 + 0.8 * r());
    return { id: `p${i}`, name: `Player ${i}`, pos: [['PG', 'SG', 'SF', 'PF', 'C'][i % 5]], projG: Math.round(55 + 25 * r()), min,
      fga, fgm: fga * (0.42 + 0.12 * r()), fta, ftm: fta * (0.65 + 0.25 * r()), tpm: 0.4 + 3 * s * r(),
      pts: 5 + 22 * s, reb: 2 + 9 * s * r(), ast: 1 + 7 * s * r(), stl: 0.4 + 1.2 * s * r(), blk: 0.2 + 1.8 * s * r(), tov: 0.6 + 2.6 * s };
  });
}

test('dollars over the drafted pool add up to the whole budget', () => {
  const ranked = computeValues(fakePlayers());
  const n = DEFAULT_LEAGUE.teams * DEFAULT_LEAGUE.rosterSize;
  const total = ranked.slice(0, n).reduce((s, p) => s + p.dollars, 0);
  assert.ok(Math.abs(total - DEFAULT_LEAGUE.teams * DEFAULT_LEAGUE.budget) < 0.01, `total ${total}`);
  assert.equal(ranked[n].dollars, 0);
  assert.ok(ranked[0].dollars > 40 && ranked[0].dollars < 120, `top ${ranked[0].dollars}`);
  assert.ok(Math.abs(ranked[n - 1].dollars - 1) < 0.5, 'last drafted player is about $1');
});

test('turnovers count against a player', () => {
  const ps = fakePlayers();
  const base = computeValues(ps).find(p => p.id === 'p10');
  const worse = computeValues(ps.map(p => (p.id === 'p10' ? { ...p, tov: p.tov + 2 } : p))).find(p => p.id === 'p10');
  assert.ok(worse.z.tov < base.z.tov && worse.dollars < base.dollars);
});

test('punting a category removes it from value', () => {
  const ps = fakePlayers();
  const punted = computeValues(ps, { punt: ['ft'] });
  const p = punted.find(x => x.id === 'p5');
  assert.ok(Math.abs(p.perGame - Object.entries(p.z).filter(([c]) => c !== 'ft').reduce((s, [, z]) => s + z, 0)) < 1e-9);
});

test('an injury adjustment lowers games and value', () => {
  const ps = fakePlayers();
  const before = computeValues(ps).find(p => p.id === 'p3');
  const hurt = ps.map(p => (p.id === 'p3' ? applyAdjustments(p, [{ gamesDelta: -30 }]) : p));
  const after = computeValues(hurt).find(p => p.id === 'p3');
  assert.equal(after.projG, before.projG - 30);
  assert.ok(after.dollars < before.dollars * 0.75);
});

test('minutes multiplier scales counting stats but keeps percentages', () => {
  const p = fakePlayers()[0];
  const q = applyAdjustments(p, [{ minutesMult: 1.2 }]);
  assert.ok(Math.abs(q.pts - p.pts * 1.2) < 1e-9);
  assert.ok(Math.abs(q.fgm / q.fga - p.fgm / p.fga) < 1e-12);
});

test('draft state: max bid keeps $1 per open spot, inflation rises when teams overspend early', () => {
  const ranked = computeValues(fakePlayers());
  const empty = draftState(ranked, []);
  assert.ok(Math.abs(empty.inflation - 1) < 0.01, `inflation ${empty.inflation}`);
  assert.equal(empty.teams[0].maxBid, 188);
  // Team 0 buys a $1-valued player for $60: less money left for the same value -> deflation.
  const cheap = ranked[150];
  const overpaid = draftState(ranked, [{ playerId: cheap.id, team: 0, price: 60 }]);
  assert.ok(overpaid.inflation < 1);
  assert.equal(overpaid.teams[0].maxBid, 200 - 60 - 11);
  // A star bought cheap leaves more money chasing less value -> inflation.
  const star = ranked[0];
  const bargain = draftState(ranked, [{ playerId: star.id, team: 1, price: 10 }]);
  assert.ok(bargain.inflation > 1);
});

test('names match across accents and suffixes', () => {
  assert.equal(normName('Nikola Jokić'), normName('Nikola Jokic'));
  assert.equal(normName('Jaren Jackson Jr.'), normName('Jaren Jackson'));
});

test('Basketball Reference per-game parser keeps traded players once, with the current team', () => {
  const row = (slug, name, team, g, pts) => `<tr><th data-stat="ranker">1</th><td class="left" data-stat="name_display" csk="x"><a href="/players/${slug[0]}/${slug}.html">${name}</a></td><td data-stat="age">27</td><td data-stat="team_name_abbr"><a>${team}</a></td><td data-stat="pos">SF</td><td data-stat="games">${g}</td><td data-stat="games_started">${g}</td><td data-stat="mp_per_g">33.1</td><td data-stat="fg_per_g">8.1</td><td data-stat="fga_per_g">17.0</td><td data-stat="fg3_per_g">2.1</td><td data-stat="ft_per_g">4.0</td><td data-stat="fta_per_g">5.0</td><td data-stat="trb_per_g">6.2</td><td data-stat="ast_per_g">4.4</td><td data-stat="stl_per_g">1.1</td><td data-stat="blk_per_g">0.6</td><td data-stat="tov_per_g">2.3</td><td data-stat="pts_per_g">${pts}</td></tr>`;
  const html = `<table class="stats_table" id="per_game_stats"><thead><tr><th>Rk</th></tr></thead><tbody>
    ${row('doejo01', 'Jo&#39;e Doe', '2TM', 70, 22.4)}${row('doejo01', 'Jo&#39;e Doe', 'BOS', 40, 21)}${row('doejo01', 'Jo&#39;e Doe', 'MIA', 30, 24)}
    <tr class="thead"><th>Rk</th></tr>${row('smitj01', 'Jay Smith', 'LAL', 80, 10)}
    <tr><td data-stat="name_display">League Average</td></tr></tbody></table>`;
  const ps = parsePerGame(html);
  assert.equal(ps.length, 2);
  assert.deepEqual([ps[0].name, ps[0].team, ps[0].g, ps[0].pts], ["Jo'e Doe", 'MIA', 70, 22.4]);
  assert.equal(ps[1].reb, 6.2);
});

test('G-scores shrink a noisy category and still spend the whole budget', () => {
  const ps = fakePlayers();
  const z = computeValues(ps), g = computeValues(ps, { tau: { fg: 0, ft: 0, tpm: 0, pts: 1000, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0 } });
  const zp = z.find(p => p.id === 'p0'), gp = g.find(p => p.id === 'p0');
  assert.ok(Math.abs(gp.z.pts) < Math.abs(zp.z.pts) / 3, 'points barely count when their weekly noise is huge');
  assert.ok(Math.abs(gp.z.reb - zp.z.reb) < 0.3, 'other categories are close to unchanged');
  const total = g.slice(0, 182).reduce((s, p) => s + p.dollars, 0);
  assert.ok(Math.abs(total - 2800) < 0.01);
});

test('the app script parses (a syntax slip would blank the page)', async () => {
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, ['--check', 'app.js']);
});

test('room curve: steep like a real room, holds exactly the money in this league', async () => {
  const { roomCurve } = await import('../lib/value.mjs');
  const { readFileSync } = await import('node:fs');
  const yahoo = readFileSync(new URL('../data/market/yahoo-auction.tsv', import.meta.url), 'utf8').trim().split('\n').slice(1).map(l => +l.split('\t')[2]);
  const c = roomCurve(yahoo, DEFAULT_LEAGUE);
  const n = DEFAULT_LEAGUE.teams * DEFAULT_LEAGUE.rosterSize;
  assert.equal(c.length, n);
  assert.ok(Math.abs(c.reduce((s, x) => s + x, 0) - DEFAULT_LEAGUE.teams * DEFAULT_LEAGUE.budget) < 1e-6);
  for (let i = 1; i < n; i++) assert.ok(c[i] <= c[i - 1] + 1e-9);
  assert.ok(c[0] > 5 * c[59], 'stars cost several times a #60 player');
});

test('bid limits: pay up for a player only while he beats what the money buys elsewhere', async () => {
  const { bidItems, bidLimit } = await import('../lib/value.mjs');
  // 3 spots, $20. A star worth 10, two middle players worth 4 for $3, and $1 fillers worth 0.
  const ps = [{ id: 'star', value: 10 }, { id: 'm1', value: 4 }, { id: 'm2', value: 4 }, ...Array.from({ length: 4 }, (_, i) => ({ id: `f${i}`, value: 0.01 }))];
  const items = bidItems(ps, p => ({ star: 15, m1: 3, m2: 3 }[p.id] ?? 1));
  const at = id => items.findIndex(it => it.id === id);
  // Without the star the best is m1 + m2 + a filler = 8. With him at $p, even star + two fillers (10, $p + $2)
  // beats that, so he's worth up to $18: more than the room's $15, because the alternative buys little.
  assert.equal(bidLimit(items, at('star'), 20, 3), 18);
  // Without m1: star + m2 + filler ($19) = 14. With m1 at $p: m1 + star + m2 = 18 needs p <= 2; m1 + star + filler = 14 needs p <= 4.
  assert.equal(bidLimit(items, at('m1'), 20, 3), 4);
});
