// In-season engine for league 81341: lineups, matchup odds, pickup and trade value.
// Inputs are a Yahoo snapshot (see manager/README.md) plus data/players.json projections.
import { readFileSync } from 'fs';

export const CATS = ['fg', 'ft', 'tpm', 'pts', 'reb', 'ast', 'stl', 'blk', 'tov'];
export const LABEL = { fg: 'FG%', ft: 'FT%', tpm: '3PTM', pts: 'PTS', reb: 'REB', ast: 'AST', stl: 'ST', blk: 'BLK', tov: 'TO' };
const COUNT = ['fgm', 'fga', 'ftm', 'fta', 'tpm', 'pts', 'reb', 'ast', 'stl', 'blk', 'tov'];

// Weekly per-game-rate variance (data/model/tau.json) was measured on weeks averaging ~3.4 games,
// so one game's variance is about tau * 3.4.
const GAMES_PER_TAU_WEEK = 3.4;

export const normName = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z ]/g, '').replace(/\b(jr|sr|iii|ii|iv)\b/g, '').replace(/\s+/g, '');

// Yahoo, ESPN and NBA.com disagree on a few tricodes.
const TEAM_ALIAS = { GS: 'GSW', GSW: 'GSW', NO: 'NOP', NOP: 'NOP', NY: 'NYK', NYK: 'NYK', SA: 'SAS', SAS: 'SAS',
  PHO: 'PHX', PHX: 'PHX', BRK: 'BKN', BKN: 'BKN', CHO: 'CHA', CHA: 'CHA', UTAH: 'UTA', UTA: 'UTA', WSH: 'WAS', WAS: 'WAS' };
export const normTeam = t => { const u = String(t || '').toUpperCase(); return TEAM_ALIAS[u] ?? u; };

// Which player positions can fill each Yahoo slot.
const SLOT_FITS = { PG: ['PG'], SG: ['SG'], G: ['PG', 'SG'], SF: ['SF'], PF: ['PF'], F: ['SF', 'PF'], C: ['C'],
  Util: ['PG', 'SG', 'SF', 'PF', 'C'], UTIL: ['PG', 'SG', 'SF', 'PF', 'C'] };
export const activeSlots = slots => slots.filter(s => SLOT_FITS[s]);
export const canFill = (slot, pos) => (SLOT_FITS[slot] ?? []).some(p => pos.includes(p));

// Chance a player suits up, from Yahoo's tag.
export function availability(status) {
  const s = String(status || '').toUpperCase();
  if (/^(O|OUT|INJ|IL|NA|SUSP)/.test(s)) return 0;
  if (/^(GTD|DTD|Q)/.test(s)) return 0.6;
  return 0.95;
}
export const isOut = status => availability(status) === 0;

export function loadProjections(file = 'data/players.json') {
  const players = JSON.parse(readFileSync(file, 'utf8')).players;
  const byName = new Map();
  for (const p of players) byName.set(normName(p.name), p);
  // Yahoo shortens first names ("S. Gilgeous-Alexander"); index initial + surname as a fallback.
  const byShort = new Map();
  for (const p of players) {
    const parts = p.name.split(' ');
    const key = normName(parts[0][0] + ' ' + parts.slice(1).join(' '));
    byShort.set(key, byShort.has(key) ? null : p);
  }
  return name => byName.get(normName(name)) ?? byShort.get(normName(String(name).replace(/^(\w)\w*\.?\s/, '$1 '))) ?? null;
}

// Attach projections and positions to snapshot rows; unknown players get a replacement-level line.
export function enrich(rows, lookup) {
  return rows.map(r => {
    const p = lookup(r.name);
    const pos = String(r.pos || p?.pos?.join(',') || 'Util').split(/[,/ ]+/).filter(Boolean);
    const line = p ? Object.fromEntries(COUNT.map(k => [k, p[k] ?? 0])) : REPLACEMENT;
    return { ...r, nba: normTeam(r.nba || p?.team), pos, line, known: !!p, avail: availability(r.status ?? p?.injury),
      market: p?.market ?? p?.yahoo?.avg ?? 1 };
  });
}
const REPLACEMENT = { fgm: 3.2, fga: 7.0, ftm: 1.1, fta: 1.4, tpm: 0.9, pts: 8.4, reb: 3.5, ast: 1.8, stl: 0.6, blk: 0.4, tov: 1.0 };

// A one-number per-game value used only to order players inside lineup and drop decisions.
export function quickValue(line) {
  return line.pts / 10 + line.reb / 4 + line.ast / 3 + line.stl * 1.5 + line.blk * 1.5 + line.tpm / 1.5 - line.tov / 2
    + (line.fgm - 0.475 * line.fga) / 1.5 + (line.ftm - 0.78 * line.fta) / 1.5;
}

// Best lineup for one day. Slots form a transversal matroid, so taking players in value order and
// keeping each one an augmenting path can place gives the max-value set of starters.
export function bestLineup(players, slots) {
  const act = activeSlots(slots);
  const owner = new Array(act.length).fill(-1);
  const order = players.map((p, i) => [quickValue(p.line) * p.avail, i]).filter(([v]) => v > 0).sort((a, b) => b[0] - a[0]);
  const place = (i, seen) => {
    for (let s = 0; s < act.length; s++) {
      if (seen[s] || !canFill(act[s], players[i].pos)) continue;
      seen[s] = true;
      if (owner[s] < 0 || place(owner[s], seen)) { owner[s] = i; return true; }
    }
    return false;
  };
  for (const [, i] of order) place(i, []);
  return act.map((slot, s) => ({ slot, player: owner[s] >= 0 ? players[owner[s]] : null }));
}

// Expected stat totals (and variances) for a roster over the given dates, starting the best lineup daily.
export function projectRange(roster, dates, schedule, slots) {
  const mean = Object.fromEntries(COUNT.map(k => [k, 0]));
  const vari = Object.fromEntries(CATS.map(c => [c, 0]));
  const games = new Map();
  for (const d of dates) {
    const playing = new Set((schedule[d] ?? []).map(normTeam));
    const today = roster.filter(p => playing.has(p.nba) && p.avail > 0 && p.slot !== 'IL');
    for (const { player: p } of bestLineup(today, slots)) {
      if (!p) continue;
      games.set(p.name, (games.get(p.name) ?? 0) + 1);
      for (const k of COUNT) mean[k] += p.avail * p.line[k];
      for (const c of CATS) vari[c] += p.avail * gameVar(c, p.line);
    }
  }
  return { mean, vari, games };
}

let TAU = null;
export function gameVar(c, line) {
  TAU ??= JSON.parse(readFileSync('data/model/tau.json', 'utf8')).tau;
  // tau is pooled across regulars; scale counting stats by the player's own rate so bench guys aren't as noisy as stars.
  const scale = c === 'fg' || c === 'ft' ? 1 : Math.max(0.25, line[c] / POOL_RATE[c]);
  return TAU[c] * GAMES_PER_TAU_WEEK * scale;
}
const POOL_RATE = { tpm: 1.6, pts: 14.5, reb: 5.3, ast: 3.4, stl: 0.9, blk: 0.6, tov: 1.6 };

const phi = x => 0.5 * (1 + erf(x / Math.SQRT2));
function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

// Category-by-category win chances for A vs B. `sofar` adds stats already banked this week.
export function matchup(a, b, sofarA = null, sofarB = null) {
  const add = (m, s) => s ? Object.fromEntries(COUNT.map(k => [k, m[k] + (s[k] ?? 0)])) : m;
  const A = add(a.mean, sofarA), B = add(b.mean, sofarB);
  const p = {};
  for (const c of CATS) {
    if (c === 'fg' || c === 'ft') {
      const [m, att] = c === 'fg' ? ['fgm', 'fga'] : ['ftm', 'fta'];
      const pa = A[m] / (A[att] || 1), pb = B[m] / (B[att] || 1);
      // Variance of a percentage = variance of makes-above-average over attempts squared.
      const sd = Math.sqrt(a.vari[c] / (A[att] || 1) ** 2 + b.vari[c] / (B[att] || 1) ** 2) || 1e-6;
      p[c] = phi((pa - pb) / sd);
    } else {
      const sd = Math.sqrt(a.vari[c] + b.vari[c]) || 1e-6;
      const diff = c === 'tov' ? B[c] - A[c] : A[c] - B[c];
      p[c] = phi(diff / sd);
    }
  }
  const expCats = CATS.reduce((s, c) => s + p[c], 0);
  return { p, expCats, winProb: winProb(p), totals: { A, B } };
}

// Chance of winning more categories than the opponent (5+ of 9, ties split), treating categories as independent.
export function winProb(p) {
  let dist = [1];
  for (const c of CATS) {
    const next = new Array(dist.length + 1).fill(0);
    dist.forEach((q, k) => { next[k] += q * (1 - p[c]); next[k + 1] += q * p[c]; });
    dist = next;
  }
  return dist.reduce((s, q, k) => s + (k >= 5 ? q : 0), 0);
}

// Dates (YYYY-MM-DD) from `from` to `to` inclusive.
export function dateRange(from, to) {
  const out = [];
  for (let d = new Date(from + 'T12:00:00Z'); d <= new Date(to + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}
