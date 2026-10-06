// Head-to-head simulation: which valuation formula drafts teams that actually win this league's weeks?
//
// For a past season, every player's real season averages stand in for a perfect projection, so the only
// thing that differs between runs is the formula that turns stats into a ranking. One test team drafts by
// formula X while the other 13 draft by the baseline (plain z-scores), snake order, the test team taking
// each of the 14 draft slots in turn. Then the real season is replayed week by week: the test team plays
// all 13 others in the 9 categories each week. 50% means no better than the baseline.
//
// Usage: node scripts/simulate-h2h.mjs [season]   -> data/eval-h2h.json
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { computeValues, CATS, CAT_LABEL } from '../lib/value.mjs';

const TEAMS = 14, ROSTER = 13;
const season = +(process.argv[2] ?? 2026);
const weeklyFile = s => `data/history/weekly-${s}.json`;
if (!existsSync(weeklyFile(season))) { console.log(`No ${weeklyFile(season)}; run scripts/fetch-weekly.mjs`); process.exit(0); }
const W = JSON.parse(readFileSync(weeklyFile(season), 'utf8'));
const K = ['fgm', 'fga', 'ftm', 'fta', 'tpm', 'pts', 'reb', 'ast', 'stl', 'blk', 'tov', 'min'];

// Season per-game averages from the weekly totals.
function seasonLines(w) {
  return w.players.map(p => {
    const tot = Object.fromEntries([...K, 'gp'].map(k => [k, 0]));
    for (const wk of Object.values(p.weeks)) for (const k of [...K, 'gp']) tot[k] += wk[k];
    const line = { id: p.espnId, name: p.name, projG: tot.gp, pos: [] };
    for (const k of K) line[k] = tot.gp ? tot[k] / tot.gp : 0;
    return line;
  }).filter(p => p.projG >= 5);
}

// Week-to-week variance of each category's per-game rate, averaged over regulars: the H2H "noise".
export function weeklyTau(w, pool) {
  const ids = new Set(pool.map(p => p.id));
  const all = w.players.filter(p => ids.has(p.espnId));
  const fgPct = pool.reduce((s, p) => s + p.fgm, 0) / pool.reduce((s, p) => s + p.fga, 0);
  const ftPct = pool.reduce((s, p) => s + p.ftm, 0) / pool.reduce((s, p) => s + p.fta, 0);
  const acc = Object.fromEntries(CATS.map(c => [c, []]));
  for (const p of all) {
    const rates = Object.values(p.weeks).filter(wk => wk.gp >= 2).map(wk => ({
      fg: (wk.fgm - fgPct * wk.fga) / wk.gp, ft: (wk.ftm - ftPct * wk.fta) / wk.gp, tpm: wk.tpm / wk.gp, pts: wk.pts / wk.gp,
      reb: wk.reb / wk.gp, ast: wk.ast / wk.gp, stl: wk.stl / wk.gp, blk: wk.blk / wk.gp, tov: wk.tov / wk.gp }));
    if (rates.length < 6) continue;
    for (const c of CATS) {
      const m = rates.reduce((s, r) => s + r[c], 0) / rates.length;
      acc[c].push(rates.reduce((s, r) => s + (r[c] - m) ** 2, 0) / (rates.length - 1));
    }
  }
  return Object.fromEntries(CATS.map(c => [c, acc[c].reduce((s, v) => s + v, 0) / acc[c].length]));
}

function draft(rankings, testSlot) {
  const teams = Array.from({ length: TEAMS }, () => []);
  const taken = new Set();
  for (let round = 0; round < ROSTER; round++) {
    const order = [...Array(TEAMS).keys()];
    if (round % 2) order.reverse();
    for (const t of order) {
      const list = t === testSlot ? rankings.test : rankings.base;
      const pick = list.find(id => !taken.has(id));
      taken.add(pick); teams[t].push(pick);
    }
  }
  return teams;
}

function play(teams, testSlot, weeksById) {
  const weeks = [...new Set([...weeksById.values()].flatMap(p => Object.keys(p.weeks)))].map(Number).sort((a, b) => a - b).slice(0, 17);
  const won = Object.fromEntries(CATS.map(c => [c, 0]));
  let games = 0;
  for (const w of weeks) {
    const tot = teams.map(ids => {
      const t = Object.fromEntries(K.map(k => [k, 0]));
      for (const id of ids) { const wk = weeksById.get(id)?.weeks[w]; if (wk) for (const k of K) t[k] += wk[k]; }
      return { fg: t.fga ? t.fgm / t.fga : 0, ft: t.fta ? t.ftm / t.fta : 0, tpm: t.tpm, pts: t.pts, reb: t.reb, ast: t.ast, stl: t.stl, blk: t.blk, tov: -t.tov };
    });
    for (let o = 0; o < TEAMS; o++) {
      if (o === testSlot) continue;
      games++;
      for (const c of CATS) won[c] += tot[testSlot][c] > tot[o][c] ? 1 : tot[testSlot][c] === tot[o][c] ? 0.5 : 0;
    }
  }
  return { won, games };
}

const lines = seasonLines(W);
const weeksById = new Map(W.players.map(p => [p.espnId, p]));
const base = computeValues(lines);
const pool = base.slice(0, TEAMS * ROSTER);
// Estimate the weekly noise from a different season where we have one, so the test isn't fitted to itself.
const tauSeason = existsSync(weeklyFile(season - 1)) ? season - 1 : season;
const tauW = tauSeason === season ? W : JSON.parse(readFileSync(weeklyFile(tauSeason), 'utf8'));
const tau = weeklyTau(tauW, computeValues(seasonLines(tauW)).slice(0, TEAMS * ROSTER));

const formulas = {
  'z-scores (current)': base,
  'z-scores capped at ±3': computeValues(lines, { cap: 3 }),
  'z-scores capped at ±2': computeValues(lines, { cap: 2 }),
  'G-scores (z with weekly noise)': computeValues(lines, { tau }),
};
const baseRank = base.map(p => p.id);
const results = [];
for (const [label, ranked] of Object.entries(formulas)) {
  const test = ranked.map(p => p.id);
  const won = Object.fromEntries(CATS.map(c => [c, 0]));
  let games = 0;
  for (let slot = 0; slot < TEAMS; slot++) {
    const r = play(draft({ test, base: baseRank }, slot), slot, weeksById);
    for (const c of CATS) won[c] += r.won[c];
    games += r.games;
  }
  const byCat = Object.fromEntries(CATS.map(c => [CAT_LABEL[c], +(won[c] / games).toFixed(3)]));
  const overall = CATS.reduce((s, c) => s + won[c], 0) / (games * CATS.length);
  results.push({ formula: label, categoryWinRate: +overall.toFixed(4), byCategory: byCat });
}
const giannis = Object.fromEntries(Object.entries(formulas).map(([k, r]) => [k, r.find(p => /Antetokounmpo/.test(p.name))?.rank]));
const out = { builtAt: new Date().toISOString(), season, tauFrom: tauSeason, tau, method: 'One team drafts by the formula, 13 by plain z-scores, snake draft from each slot in turn; real weekly stats replayed over 17 weeks against all 13 opponents. Category win rate: 50% = no better than plain z-scores.', results, giannisRank: giannis };
writeFileSync(`data/eval-h2h-${season}.json`, JSON.stringify(out, null, 1) + '\n');
console.table(results.map(r => ({ formula: r.formula, 'cat win %': (r.categoryWinRate * 100).toFixed(1), ...Object.fromEntries(Object.entries(r.byCategory).map(([k, v]) => [k, Math.round(v * 100)])) })));
console.log('Giannis rank under each formula:', giannis);
