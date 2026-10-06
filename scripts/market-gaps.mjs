// Where does the app disagree with the market, and why? Compares the app's values with the market's
// average auction prices (Yahoo when transcribed, else ESPN), after putting the market on this league's scale:
// each player's market rank is priced at what that rank costs here. Then tests explanations.
// Usage: node scripts/market-gaps.mjs   -> data/eval-market.json and a printed report
import { readFileSync, writeFileSync } from 'node:fs';
import { computeValues, CATS } from '../lib/value.mjs';
import { spearman } from '../lib/evaluate.mjs';

const P = JSON.parse(readFileSync('data/players.json', 'utf8')).players;
const tau = JSON.parse(readFileSync('data/model/tau.json', 'utf8')).tau;
const v = computeValues(P, { tau });
const curve = v.map(p => p.dollars); // this league's price at each rank
const withMkt = v.filter(p => p.market > 0).sort((a, b) => b.market - a.market);
withMkt.forEach((p, i) => { p.mktRank = i + 1; p.mktHere = curve[i] ?? 0; });

// ESPN's default head-to-head points scoring, per game, times games.
const espnPoints = p => p.pts + p.tpm + 2 * p.fgm - p.fga + p.ftm - p.fta + p.reb + 2 * p.ast + 4 * p.stl + 4 * p.blk - 2 * p.tov;
const byPts = [...v].sort((a, b) => espnPoints(b) * b.projG - espnPoints(a) * a.projG);
byPts.forEach((p, i) => (p.ptsRank = i + 1));
// Plain 9-cat z-scores, no weekly noise, for comparison.
const zRank = new Map(computeValues(P).map(p => [p.id, p.rank]));

const pool = withMkt.filter(p => p.mktRank <= 150 || p.rank <= 150);
const corr = (a, b) => +spearman(pool.map(a), pool.map(b)).toFixed(3);
const fit = {
  'app (G-scores, 9-cat)': corr(p => -p.rank, p => -p.mktRank),
  'plain 9-cat z-scores': corr(p => -zRank.get(p.id), p => -p.mktRank),
  'ESPN points-league ranking': corr(p => -p.ptsRank, p => -p.mktRank),
  "Yahoo's own preseason rank": corr(p => -(p.yahoo?.rank ?? 999), p => -p.mktRank),
};

const gap = p => p.dollars - p.mktHere;
const top = [...pool].sort((a, b) => Math.abs(gap(b)) - Math.abs(gap(a))).slice(0, 10);
const cats = p => Object.fromEntries(CATS.map(c => [c, +p.z[c].toFixed(2)]));
const report = top.map(p => ({
  name: p.name, team: p.team, age: p.age, value: Math.round(p.dollars), rank: p.rank, market: p.market, marketRank: p.mktRank,
  marketHere: Math.round(p.mktHere), gap: Math.round(gap(p)), pointsRank: p.ptsRank, zRank: zRank.get(p.id),
  projG: p.projG, espnG: p.sources?.espn?.g, fpG: p.sources?.fp?.g, min: +p.min.toFixed(1), z: cats(p),
  depth: p.depth, injury: p.injury, jevFlags: p.jevFlags ?? {}, notes: [...(p.flags ?? []), ...(p.notes ?? [])],
}));
writeFileSync('data/eval-market.json', JSON.stringify({ builtAt: new Date().toISOString(), method: 'Market rank priced on this league\'s curve; rank agreement (Spearman) over players top 150 by either', agreement: fit, top }, null, 1) + '\n');
console.log('Rank agreement with ESPN market:', JSON.stringify(fit));
for (const r of report) console.log(`\n${r.name} (${r.team}, ${r.age}) app $${r.value} #${r.rank} | market #${r.marketRank} → $${r.marketHere} here (ESPN $${r.market}) | gap ${r.gap > 0 ? '+' : ''}${r.gap} | points-league #${r.pointsRank}, plain z #${r.zRank}
  games ${r.projG} (ESPN ${r.espnG}, FP ${r.fpG}) · ${r.min} min · ${r.depth ? (r.depth.starter ? 'starter' : 'depth #' + r.depth.rank) : 'no depth slot'}${r.injury ? ' · ' + r.injury : ''}
  z: ${Object.entries(r.z).map(([c, z]) => `${c} ${z > 0 ? '+' : ''}${z}`).join(' ')}
  Jev: ${Object.entries(r.jevFlags).map(([k, x]) => k + ' ' + x).join(', ') || '-'}${r.notes.length ? '\n  notes: ' + r.notes.join(' | ') : ''}`);
