// Parsers for the external sources fetched by scripts/fetch-sources.mjs.
// Every parser returns per-game rows in the engine's shape:
// { name, team, pos:[], age, projG, min, fgm, fga, ftm, fta, tpm, pts, reb, ast, stl, blk, tov }

// ESPN fantasy stat ids (basketball).
const ESPN = { pts: 0, blk: 1, stl: 2, ast: 3, reb: 6, tov: 11, fgm: 13, fga: 14, ftm: 15, fta: 16, tpm: 17, min: 40 };
const ESPN_SLOT = { 0: 'PG', 1: 'SG', 2: 'SF', 3: 'PF', 4: 'C' };
export const ESPN_TEAM = { 1: 'ATL', 2: 'BOS', 3: 'NOP', 4: 'CHI', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET', 9: 'GSW', 10: 'HOU', 11: 'IND', 12: 'LAC', 13: 'LAL', 14: 'MIA', 15: 'MIL', 16: 'MIN', 17: 'BKN', 18: 'NYK', 19: 'ORL', 20: 'PHI', 21: 'PHX', 22: 'POR', 23: 'SAC', 24: 'SAS', 25: 'OKC', 26: 'UTA', 27: 'WAS', 28: 'TOR', 29: 'MEM', 30: 'CHA', 0: 'FA' };

// key: '10<season>' for ESPN's preseason projection, '00<season>' for what happened.
export function espnLine(player, key) {
  const s = player.stats?.find(x => x.id === key);
  const avg = s?.averageStats, tot = s?.stats;
  if (!avg || !Object.keys(avg).length) return null;
  const row = {};
  for (const [k, id] of Object.entries(ESPN)) row[k] = +(avg[id] ?? 0);
  row.projG = Math.round(tot?.[42] ?? (avg[0] ? (tot?.[0] ?? 0) / avg[0] : 0));
  return row;
}

export function parseEspnPlayers(json, season) {
  return (json.players ?? []).map(({ player: p }) => ({
    espnId: String(p.id), name: p.fullName, team: ESPN_TEAM[p.proTeamId] ?? '', pos: (p.eligibleSlots ?? []).map(s => ESPN_SLOT[s]).filter(Boolean),
    injury: p.injuryStatus, outlook: p.seasonOutlook,
    market: { espnAvgAuction: p.ownership?.auctionValueAverage ?? null, espnAuction: p.draftRanksByRankType?.STANDARD?.auctionValue ?? null, adp: p.ownership?.averageDraftPosition ?? null },
    proj: espnLine(p, `10${season}`), last: espnLine(p, `00${season - 1}`), actual: espnLine(p, `00${season}`),
  }));
}

// FantasyPros consensus season projections: totals per season, no attempt counts.
const decode = s => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#0?39;|&#x27;/g, "'").trim();
export function parseFantasyPros(html) {
  const head = html.slice(html.indexOf('<thead'), html.indexOf('</thead>'));
  const cols = [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(m => decode(m[1]).toUpperCase());
  const at = name => cols.indexOf(name);
  const body = html.slice(html.indexOf('<tbody'), html.indexOf('</tbody>'));
  const rows = [];
  for (const tr of body.split(/<tr[\s>]/).slice(1)) {
    const name = /fp-player-name="([^"]+)"/.exec(tr)?.[1];
    if (!name) continue;
    const meta = /<small>\(([^)]*)\)<\/small>/.exec(tr)?.[1] ?? '';
    const [team, posStr] = meta.split(' - ');
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => decode(m[1]));
    const n = c => +String(cells[at(c)] ?? '').replace(/,/g, '') || 0;
    const g = n('GP');
    if (!g) continue;
    rows.push({
      name: decode(name), team: team?.trim(), pos: (posStr ?? '').split(',').map(x => x.trim()).filter(x => ESPN_SLOT_SET.has(x)),
      projG: g, min: n('MIN') / g, pts: n('PTS') / g, reb: n('REB') / g, ast: n('AST') / g, blk: n('BLK') / g, stl: n('STL') / g,
      tpm: n('3PM') / g, tov: n('TO') / g, fgPct: n('FG%'), ftPct: n('FT%'),
    });
  }
  return rows;
}
const ESPN_SLOT_SET = new Set(Object.values(ESPN_SLOT));

// ESPN depth charts: for each player, his best (lowest) rank at any position and whether he starts.
export function depthIndex(depthJson) {
  const out = new Map();
  for (const t of Object.values(depthJson.teams ?? {})) {
    for (const [pos, ids] of Object.entries(t.depth ?? {})) {
      ids.forEach((id, i) => {
        if (!id) return;
        const cur = out.get(id);
        const rank = i + 1;
        if (!cur || rank < cur.rank) out.set(id, { team: t.abbr, pos: pos.toUpperCase(), rank, starter: rank === 1 });
      });
    }
  }
  return out;
}
