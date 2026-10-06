// How an absent player's minutes and shots are shared out, measured on real weekly game logs.
// For every rotation player (24+ mpg) and every teammate, compare the teammate's per-game minutes and
// per-minute scoring in weeks the player missed entirely with weeks he played. Splits by position group
// (guard / wing / big) and by the teammate's place in that group's minutes pecking order.
// Usage: node scripts/fit-cascade.mjs   -> data/model/cascade.json
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const ESPN_POS = { 1: 'G', 2: 'G', 3: 'W', 4: 'B', 5: 'B' }; // ESPN defaultPositionId: PG, SG, SF, PF, C
const seasons = [2024, 2025, 2026].filter(s => existsSync(`data/history/weekly-${s}.json`) && existsSync(`data/sources/espn-history-${s}.json`));
const pairs = []; // one row per (absent player, teammate, season)

for (const T of seasons) {
  const W = JSON.parse(readFileSync(`data/history/weekly-${T}.json`, 'utf8')).players;
  const meta = new Map(JSON.parse(readFileSync(`data/sources/espn-history-${T}.json`, 'utf8')).players
    .map(({ player: p }) => [String(p.id), { team: p.proTeamId, group: ESPN_POS[p.defaultPositionId] ?? 'W' }]));
  const players = W.map(p => {
    const m = meta.get(p.espnId);
    let gp = 0, min = 0, pts = 0, fga = 0;
    for (const w of Object.values(p.weeks)) { gp += w.gp; min += w.min; pts += w.pts; fga += w.fga; }
    return { ...p, team: m?.team, group: m?.group ?? 'W', gp, mpg: gp ? min / gp : 0 };
  }).filter(p => p.team && p.gp >= 20);
  const byTeam = new Map();
  for (const p of players) { if (!byTeam.has(p.team)) byTeam.set(p.team, []); byTeam.get(p.team).push(p); }

  for (const roster of byTeam.values()) {
    const teamWeeks = new Set(roster.flatMap(p => Object.entries(p.weeks).filter(([, w]) => w.gp >= 2).map(([k]) => k)));
    for (const a of roster.filter(p => p.mpg >= 24)) {
      const absent = [...teamWeeks].filter(k => !a.weeks[k]); // he played no game that week
      const present = [...teamWeeks].filter(k => a.weeks[k]?.gp >= 2);
      if (absent.length < 2 || present.length < 4) continue;
      const mates = roster.filter(b => b !== a && b.mpg >= 8);
      // Pecking order inside a's position group, by season minutes.
      const sameGroup = mates.filter(b => b.group === a.group).sort((x, y) => y.mpg - x.mpg);
      for (const b of mates) {
        const rate = ks => {
          let gp = 0, min = 0, pts = 0;
          for (const k of ks) { const w = b.weeks[k]; if (w?.gp) { gp += w.gp; min += w.min; pts += w.pts; } }
          return gp ? { gp, mpg: min / gp, ppm: min ? pts / min : 0 } : null;
        };
        const off = rate(absent), on = rate(present);
        if (!off || !on || off.gp < 3) continue;
        pairs.push({ season: T, absentMpg: a.mpg, same: b.group === a.group, rank: b.group === a.group ? sameGroup.indexOf(b) + 1 : null,
          mateMpg: b.mpg, dMin: off.mpg - on.mpg, dPpm: off.ppm - on.ppm, weight: Math.min(off.gp, 12) });
      }
    }
  }
}

// Weighted averages: minutes gained per minute the absent player normally plays.
const avg = (rows, f) => { const w = rows.reduce((s, r) => s + r.weight, 0); return w ? rows.reduce((s, r) => s + f(r) * r.weight, 0) / w : 0; };
const share = rows => +avg(rows, r => r.dMin / r.absentMpg).toFixed(4);
const groups = {
  sameGroupRank1: pairs.filter(r => r.same && r.rank === 1),
  sameGroupRank2: pairs.filter(r => r.same && r.rank === 2),
  sameGroupRank3plus: pairs.filter(r => r.same && r.rank >= 3),
  otherGroup: pairs.filter(r => !r.same),
};
const model = Object.fromEntries(Object.entries(groups).map(([k, rows]) => [k, { pairs: rows.length, minutesShare: share(rows),
  pointsPerMinuteChange: +avg(rows, r => r.dPpm).toFixed(4) }]));
// Per-season check that the shares hold up.
const bySeason = Object.fromEntries(seasons.map(T => [T, Object.fromEntries(Object.entries(groups).map(([k, rows]) => [k, share(rows.filter(r => r.season === T))]))]));
// Total absorbed: the shares times how many teammates typically sit in each slot.
mkdirSync('data/model', { recursive: true });
const out = { builtAt: new Date().toISOString(), seasons, method: 'Teammate per-game minutes in weeks a 24+ mpg player missed entirely, minus weeks he played, divided by his minutes. Weighted by games.', model, bySeason };
writeFileSync('data/model/cascade.json', JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify({ model, bySeason }, null, 1));
