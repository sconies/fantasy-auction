// Helpers shared by the H2H simulation and the G-score noise estimate.
import { CATS } from './value.mjs';

const K = ['fgm', 'fga', 'ftm', 'fta', 'tpm', 'pts', 'reb', 'ast', 'stl', 'blk', 'tov', 'min'];

// Season per-game averages from the weekly totals.
export function seasonLines(w) {
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

