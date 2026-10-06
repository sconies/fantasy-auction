// Parse Basketball Reference's per-game table (handles both the old and the 2025 data-stat names).

const ALIASES = {
  name: ['name_display', 'player'], team: ['team_name_abbr', 'team_id'], pos: ['pos'], age: ['age'],
  g: ['games', 'g'], gs: ['games_started', 'gs'], min: ['mp_per_g'],
  fgm: ['fg_per_g'], fga: ['fga_per_g'], tpm: ['fg3_per_g'], ftm: ['ft_per_g'], fta: ['fta_per_g'],
  reb: ['trb_per_g'], ast: ['ast_per_g'], stl: ['stl_per_g'], blk: ['blk_per_g'], tov: ['tov_per_g'], pts: ['pts_per_g'],
};
const TEXT = new Set(['name', 'team', 'pos']);
const decode = s => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ').trim();

export function parsePerGame(html) {
  const start = html.indexOf('id="per_game_stats"');
  if (start < 0) return [];
  const body = html.slice(start, html.indexOf('</table>', start));
  const byId = new Map();
  for (const tr of body.split(/<tr[\s>]/).slice(1)) {
    if (/class="[^"]*thead/.test(tr.slice(0, 80))) continue;
    const cells = {};
    for (const m of tr.matchAll(/<t[dh][^>]*data-stat="([^"]+)"[^>]*>([\s\S]*?)<\/t[dh]>/g)) cells[m[1]] = m[2];
    const get = k => { for (const a of ALIASES[k]) if (a in cells) return cells[a]; };
    const nameCell = get('name');
    const href = nameCell && /href="\/players\/\w\/([\w.-]+)\.html"/.exec(nameCell);
    if (!href) continue; // header repeats, League Average
    const row = { id: href[1] };
    for (const k of Object.keys(ALIASES)) {
      const v = get(k);
      row[k] = TEXT.has(k) ? decode(v ?? '') : Number(decode(v ?? '')) || 0;
    }
    const prev = byId.get(row.id);
    if (!prev) byId.set(row.id, row);            // traded players: the combined (2TM/TOT) row comes first
    else if (!/^\d?TM$|^TOT$/.test(row.team)) prev.team = row.team; // ...and the last team row is where he plays now
  }
  return [...byId.values()];
}
