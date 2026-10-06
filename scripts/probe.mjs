// Diagnostic: how to get complete ESPN game logs. Not part of the data job.
const H = f => ({ 'user-agent': 'Mozilla/5.0', 'x-fantasy-filter': JSON.stringify(f) });
const base = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/2026/segments/0/leaguedefaults/3';
const count = d => { let g = 0, per = []; for (const { player } of d.players ?? []) { const n = (player.stats ?? []).filter(s => s.statSplitTypeId === 5 && s.stats?.[42]).length; g += n; per.push(n); } return `${d.players?.length} players, ${g} games, per player ${per.slice(0, 8).join(',')}`; };
const tries = [
  ['top 100', `${base}?view=kona_player_info`, { players: { limit: 5, sortAppliedStatTotal: { sortAsc: false, sortPriority: 1, value: '002026' }, filterStatsForTopScoringPeriodIds: { value: 100, additionalValue: ['002026'] } } }],
  ['top 82', `${base}?view=kona_player_info`, { players: { limit: 5, sortAppliedStatTotal: { sortAsc: false, sortPriority: 1, value: '002026' }, filterStatsForTopScoringPeriodIds: { value: 82, additionalValue: ['002026'] } } }],
  ['playercard', `${base}?view=kona_playercard`, { players: { filterIds: { value: [3112335] }, filterStatsForTopScoringPeriodIds: { value: 200, additionalValue: ['002026'] } } }],
  ['day 60', `${base}?view=kona_player_info&scoringPeriodId=60`, { players: { limit: 5, sortAppliedStatTotal: { sortAsc: false, sortPriority: 1, value: '002026' } } }],
];
for (const [label, url, f] of tries) {
  try { const r = await fetch(url, { headers: H(f) }); const d = await r.json(); console.log(label, r.status, count(d)); }
  catch (e) { console.log(label, 'ERROR', e.message); }
}
