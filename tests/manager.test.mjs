import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestLineup, winProb, availability, normTeam, matchup, CATS } from '../manager/model.mjs';

const line = v => ({ fgm: 4, fga: 9, ftm: 2, fta: 2.5, tpm: 1, pts: 10 * v, reb: 4, ast: 2, stl: 1, blk: 0.5, tov: 1 });
const pl = (name, pos, v = 1) => ({ name, pos, line: line(v), avail: 0.95 });

test('lineup moves a flexible player to make room', () => {
  // Greedy would put the PG/SG star at PG and leave the pure PG on the bench.
  const lineup = bestLineup([pl('combo', ['PG', 'SG'], 3), pl('pure', ['PG'], 2)], ['PG', 'SG', 'BN']);
  assert.deepEqual(lineup.map(s => s.player?.name), ['pure', 'combo']);
});

test('lineup ignores bench and IL slots and out players', () => {
  const out = { ...pl('hurt', ['C'], 5), avail: 0 };
  const lineup = bestLineup([out, pl('ok', ['C'])], ['C', 'BN', 'IL']);
  assert.equal(lineup.length, 1);
  assert.equal(lineup[0].player.name, 'ok');
});

test('win probability is 1/2 for a coin-flip matchup and rises with edges', () => {
  const half = Object.fromEntries(CATS.map(c => [c, 0.5]));
  assert.ok(Math.abs(winProb(half) - 0.5) < 1e-9);
  assert.ok(winProb({ ...half, pts: 0.9, reb: 0.9 }) > 0.6);
});

test('lower turnovers win the TO category', () => {
  const t = tov => ({ mean: { ...line(1), tov }, vari: Object.fromEntries(CATS.map(c => [c, 1])) });
  assert.ok(matchup(t(10), t(20)).p.tov > 0.99);
});

test('status tags and team codes', () => {
  assert.equal(availability('O'), 0);
  assert.equal(availability('INJ'), 0);
  assert.equal(availability('GTD'), 0.6);
  assert.equal(normTeam('GS'), 'GSW');
  assert.equal(normTeam('PHO'), 'PHX');
});
