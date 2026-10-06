import { FLAGS } from './lib/flags.mjs';
import { CATS, CAT_LABEL, applyAdjustments, computeValues, draftState, categoryTotals, fitScore, tierOf, normName } from './lib/value.mjs';

const KEY = 'fa:v1';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = x => `${x < -0.5 ? "-" : ""}$${Math.abs(Math.round(x))}`;

// ---------- state ----------
const blank = () => ({
  overrides: {},          // id -> { dollars, tag, note, games, minutesMult }
  decisions: {},          // adjustment id -> 'accepted' | 'rejected'
  punt: [],
  market: {},             // normName -> $ (e.g. Yahoo average cost)
  importedPlayers: null,  // projections pasted in Setup replace the built file
  draft: { teams: Array.from({ length: 14 }, (_, i) => `Team ${i + 1}`), me: 0, picks: [], current: null },
  filters: { q: '', pos: 'All', show: 'all' },
});
let S = blank();
try { S = { ...S, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} };

let league, built, news, claudeAdj, evalData, qa, roles, tau, h2h, jev, jevTest, cascade, flagEval, flagTest, signals, newsRun, riskModel;
let tab = 'ranks';
let lastCascade = new Map();
let ranked = [], byId = new Map();

const loadJson = async (f, fallback) => { try { const r = await fetch(f, { cache: 'no-cache' }); return r.ok ? await r.json() : fallback; } catch { return fallback; } };

async function init() {
  [league, built, news, claudeAdj, evalData, qa, roles] = await Promise.all([
    loadJson('data/league.json', {}), loadJson('data/players.json', { players: [] }),
    loadJson('data/news.json', { injuries: [], articles: [] }), loadJson('data/adjustments.json', { adjustments: [] }),
    loadJson('data/eval.json', null), loadJson('data/qa.json', null), loadJson('data/role-changes.json', { changes: [] }),
  ]);
  tau = (await loadJson('data/model/tau.json', null))?.tau ?? null;
  jev = (await loadJson('data/jev/injuries.json', null))?.byName ?? {};
  jevTest = await loadJson('data/jev/test-injuries.json', null);
  cascade = (await loadJson('data/model/cascade.json', null))?.model ?? null;
  flagEval = await loadJson('data/eval-flags.json', null);
  flagTest = await loadJson('data/jev/test-flags.json', null);
  signals = await loadJson('data/signals.json', { signals: [] });
  newsRun = await loadJson('data/news-run.json', null);
  riskModel = await loadJson('data/model/risk.json', null);
  h2h = (await Promise.all([2026, 2025, 2024].map(y => loadJson(`data/eval-h2h-${y}-projected.json`, null)))).filter(Boolean);
  document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => { tab = b.dataset.tab; render(); });
  $('#sheet').onclick = e => { if (e.target.id === 'sheet') closeSheet(); };
  recompute(); render();
}

const basePlayers = () => S.importedPlayers ?? built.players ?? [];

// ---------- adjustments: news proposals + your own edits ----------
// Injury proposals. ESPN's return date sizes the games missed; Jev's reading of the note (tested at
// 95% on labelled notes, data/jev/test-injuries.json) checks it and covers notes without a date.
const JEV_LABEL = { none: 'no regular-season games missed', uncertain: 'might miss the opener, no timeline', weeks: '1-6 weeks of the season', months: 'more than 6 weeks', season: 'the whole season', old: 'a note about an earlier season' };
const ROUGH_GAMES = { weeks: 8, months: 30 }; // used only when a note has no return date
function injuryProposals() {
  const idx = new Map(basePlayers().map(p => [normName(p.name), p]));
  const start = new Date(league.seasonStart), end = new Date(league.seasonEnd);
  const seasonDays = (end - start) / 864e5;
  const out = [];
  for (const i of news.injuries ?? []) {
    const p = idx.get(normName(i.name));
    if (!p) continue;
    const j = jev[i.name];
    const jevText = j ? ` Jev reads the note as ${JEV_LABEL[j.choice] ?? j.choice}${j.confidence != null ? ` (${Math.round(j.confidence * 100)}% sure)` : ''}.` : '';
    let missed = null;
    if (i.returnDate) {
      const from = new Date(Math.max(Date.now(), start)), to = new Date(Math.min(new Date(i.returnDate), end));
      const days = (to - from) / 864e5;
      if (days > 3) missed = Math.round(82 * days / seasonDays);
    }
    if (j?.choice === 'season') {
      out.push({ id: `jev:${p.id}:season:${j.written}`, playerId: p.id, games: 0, source: 'Jev reading the injury note', date: i.date,
        reason: `${i.status}: "${i.comment.slice(0, 140)}…" Jev reads this as out for the whole season (${Math.round((j.confidence ?? 0) * 100)}% sure).${missed != null ? ` ESPN's date implies only ${missed} games.` : ''}` });
      continue;
    }
    if (missed != null) {
      const stale = j?.choice === 'old' || j?.choice === 'none';
      out.push({ id: `inj:${p.id}:${i.returnDate}`, playerId: p.id, gamesDelta: -missed, source: 'ESPN injury report', date: i.date, warn: stale,
        reason: `${i.status}${i.injury ? ` (${i.injury})` : ''}, expected back ${i.returnDate.slice(0, 10)}: about ${missed} games missed.${jevText}${stale ? ' The note and the date disagree: check before accepting.' : ''}` });
    } else if (j && ROUGH_GAMES[j.choice]) {
      out.push({ id: `jev:${p.id}:${j.choice}:${j.written}`, playerId: p.id, gamesDelta: -ROUGH_GAMES[j.choice], source: 'Jev reading the injury note', date: i.date, warn: true,
        reason: `${i.status}: "${i.comment.slice(0, 140)}…" No return date; Jev reads ${JEV_LABEL[j.choice]}. ${ROUGH_GAMES[j.choice]} games is a rough size: edit his games if you know better.` });
    }
  }
  return out;
}
const allProposals = () => [...(claudeAdj.adjustments ?? []), ...injuryProposals()];

function adjustmentsFor(id, proposals) {
  const list = proposals.filter(a => a.playerId === id && S.decisions[a.id] === 'accepted');
  const o = S.overrides[id];
  if (o?.games != null && o.games !== '') list.push({ games: +o.games });
  if (o?.minutesMult) list.push({ minutesMult: +o.minutesMult });
  return list;
}

// When a player is out, his minutes go to teammates in the shares measured on three seasons of game logs
// (data/model/cascade.json): same-position teammates by their place in the pecking order, others less.
const GROUP = p => ({ PG: 'G', SG: 'G', SF: 'W', PF: 'B', C: 'B' }[(p.pos ?? [])[0]] ?? 'W');
function cascadeAdjustments(proposals) {
  const out = new Map();
  if (!cascade || S.cascade === 'off') return out;
  const base = new Map(basePlayers().map(p => [p.id, p]));
  for (const a of proposals) {
    if (S.decisions[a.id] !== 'accepted') continue;
    const A = base.get(a.playerId);
    if (!A || !(A.min >= 20)) continue;
    const missed = a.games != null ? Math.max(0, A.projG - a.games) : a.gamesDelta < 0 ? -a.gamesDelta : 0;
    if (!missed) continue;
    const mates = basePlayers().filter(b => b.team === A.team && b.id !== A.id && b.min >= 8);
    const same = mates.filter(b => GROUP(b) === GROUP(A)).sort((x, y) => y.min - x.min);
    for (const B of mates) {
      const r = GROUP(B) === GROUP(A) ? same.indexOf(B) + 1 : 0;
      const slot = r === 1 ? cascade.sameGroupRank1 : r === 2 ? cascade.sameGroupRank2 : r >= 3 ? cascade.sameGroupRank3plus : cascade.otherGroup;
      const share = Math.max(0, slot?.minutesShare ?? 0);
      const extraMin = A.min * share * Math.min(missed, B.projG) / 82; // averaged over his season
      if (extraMin < 0.05) continue;
      const list = out.get(B.id) ?? [];
      list.push({ minutesMult: (B.min + extraMin) / B.min, cascadeFrom: A.name, extraMin, missed });
      out.set(B.id, list);
    }
  }
  return out;
}

function valuesWith(proposals, punt = S.punt) {
  const cas = cascadeAdjustments(proposals);
  const players = basePlayers().map(p => applyAdjustments(p, [...adjustmentsFor(p.id, proposals), ...(cas.get(p.id) ?? [])]));

  // G-scores by default: they won 61-66% of simulated weeks against plain z-scores (Setup → Data & value quality).
  return computeValues(players, { league, punt, tau: S.formula === 'z' ? null : tau });
}

function recompute() {
  lastCascade = cascadeAdjustments(allProposals());
  ranked = valuesWith(allProposals());
  byId = new Map(ranked.map(p => [p.id, p]));
  const curve = ranked.map(p => p.dollars);
  scaledMarket = new Map(ranked.filter(p => p.market > 0).sort((a, b) => b.market - a.market).map((p, i) => [p.id, curve[i] ?? 0]));
}

const ov = id => S.overrides[id] ?? {};
const mine = p => Math.max(0, p.dollars + (+ov(p.id).dollars || 0));
// Market: your pasted prices (already in this league's dollars) win. Otherwise ESPN's average auction
// price, which comes from mostly 10-team leagues, is put on this league's scale: a player's market rank
// is priced at what that rank costs here (scripts/market-gaps.mjs explains why raw prices mislead).
let scaledMarket = new Map();
const marketOf = p => S.market[normName(p.name)] ?? scaledMarket.get(p.id) ?? undefined;
const injuryOf = p => (news.injuries ?? []).find(i => normName(i.name) === normName(p.name));
const dstate = () => draftState(ranked, S.draft.picks, { league, teamCount: S.draft.teams.length, priceOf: mine });

// ---------- shared bits ----------
function catChips(p, punt = S.punt) {
  return `<div class="cats">${CATS.map(c => {
    const z = p.z?.[c] ?? 0;
    return `<span class="cat ${punt.includes(c) ? 'x' : z > 0.4 ? 'p' : z < -0.4 ? 'n' : ''}">${CAT_LABEL[c]} ${z > 0 ? '+' : ''}${z.toFixed(1)}</span>`;
  }).join('')}</div>`;
}
const depthLabel = p => (p.depth ? (p.depth.starter ? `Starter ${p.depth.pos}` : `${p.depth.pos} #${p.depth.rank}`) : 'No depth slot');
function tags(p) {
  const o = ov(p.id), inj = injuryOf(p);
  return `${o.tag ? `<span class="tag ${o.tag}">${o.tag === 'target' ? 'TARGET' : 'AVOID'}</span>` : ''}${inj ? `<span class="tag inj">${esc(inj.status)}</span>` : p.injury ? `<span class="tag inj">${esc(p.injury)}</span>` : ''}${p.flags?.length ? `<span class="tag flag" title="${esc(p.flags.join(' '))}">⚑</span>` : ''}`;
}
function playerRow(p, { right, drafted } = {}) {
  return `<div class="player ${drafted ? 'drafted' : ''}" data-open="${esc(p.id)}">
    <div class="rk">#${p.rank}</div>
    <div class="nm">${esc(p.name)}${tags(p)}</div>
    <div class="money">${right ?? defaultMoney(p)}</div>
    <div class="sub">${esc(p.team ?? '')} · ${esc((p.pos ?? []).join(','))} · ${esc(depthLabel(p))} · ${p.projG}g · ${(p.min ?? 0).toFixed(0)}m</div>
    ${catChips(p)}
  </div>`;
}
function defaultMoney(p) {
  const m = mine(p), mk = marketOf(p);
  const d = m - p.dollars;
  return `<div class="big">${money(m)}</div><div class="small">${p.risk && m > 0 ? `${money(Math.max(0, m + p.risk.low))}–${money(m + p.risk.high)} ` : ''}${d ? `model ${money(p.dollars)} ` : ''}${mk != null ? `mkt ${money(mk)}` : ''}</div>`;
}
const bindOpen = root => root.querySelectorAll('[data-open]').forEach(el => el.onclick = () => openPlayer(el.dataset.open));

// ---------- ranks ----------
function renderRanks() {
  const f = S.filters;
  const drafted = new Set(S.draft.picks.map(p => p.playerId));
  let list = [...ranked].sort((a, b) => mine(b) - mine(a) || b.value - a.value);
  if (f.q) list = list.filter(p => normName(p.name).includes(normName(f.q)));
  if (f.pos !== 'All') list = list.filter(p => (p.pos ?? []).includes(f.pos));
  if (f.show === 'target') list = list.filter(p => ov(p.id).tag === 'target');
  if (f.show === 'avoid') list = list.filter(p => ov(p.id).tag === 'avoid');
  if (f.show === 'open') list = list.filter(p => !drafted.has(p.id));
  if (f.show === 'edited') list = list.filter(p => Object.keys(ov(p.id)).length);
  if (f.show === 'flagged') list = list.filter(p => p.flags?.length);
  list = list.slice(0, 260);

  let html = `<div class="panel">
    <div class="row"><input id="q" placeholder="Search players" value="${esc(f.q)}">
      <select id="pos" class="shrink" style="width:auto">${['All', 'PG', 'SG', 'SF', 'PF', 'C'].map(x => `<option ${x === f.pos ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
    <div class="chips" style="margin-top:8px">${[['all', 'All'], ['open', 'Undrafted'], ['target', 'Targets'], ['avoid', 'Avoid'], ['edited', 'Edited'], ['flagged', '⚑ Check']].map(([k, l]) => `<button class="chip ${f.show === k ? 'on' : ''}" data-show="${k}">${l}</button>`).join('')}</div>
    <h3>Punt (click a category to ignore it)</h3>
    <div class="chips">${CATS.map(c => `<button class="chip ${S.punt.includes(c) ? 'punt' : ''}" data-punt="${c}">${CAT_LABEL[c]}</button>`).join('')}</div>
  </div>`;
  if (!ranked.length) html += `<div class="empty">No projections yet. The data job fills <code>data/players.json</code> on its first run, or paste stats under Setup.</div>`;
  let lastTier = 0;
  html += `<div class="list">${list.map(p => {
    const t = tierOf(mine(p));
    const head = t !== lastTier && !f.q ? `<div class="tier">Tier ${t}</div>` : '';
    lastTier = t;
    return head + playerRow(p, { drafted: drafted.has(p.id) });
  }).join('')}</div>`;
  $('#view').innerHTML = html;

  $('#q').oninput = e => { f.q = e.target.value; save(); renderRanksKeepFocus(); };
  $('#pos').onchange = e => { f.pos = e.target.value; save(); render(); };
  document.querySelectorAll('[data-show]').forEach(b => b.onclick = () => { f.show = b.dataset.show; save(); render(); });
  document.querySelectorAll('[data-punt]').forEach(b => b.onclick = () => {
    const c = b.dataset.punt;
    S.punt = S.punt.includes(c) ? S.punt.filter(x => x !== c) : [...S.punt, c];
    save(); recompute(); render();
  });
  bindOpen($('#view'));
}
function renderRanksKeepFocus() {
  const pos = $('#q').selectionStart;
  renderRanks();
  const q = $('#q'); q.focus(); q.setSelectionRange(pos, pos);
}

// ---------- player sheet ----------
function openPlayer(id) {
  const p = byId.get(id);
  if (!p) return;
  const o = ov(id), base = basePlayers().find(x => x.id === id) ?? {};
  const props = allProposals().filter(a => a.playerId === id);
  const inj = injuryOf(p);
  const heads = (news.articles ?? []).filter(a => a.athletes?.some(n => normName(n) === normName(p.name)) || normName(a.headline).includes(normName(p.name)));
  const line = k => (p[k] ?? 0).toFixed(1);
  $('#sheetBody').innerHTML = `
    <div class="row"><h2>${esc(p.name)} ${tags(p)}</h2><button class="ghost shrink" id="close">Close</button></div>
    <div class="muted">${esc(p.team)} · ${esc((p.pos ?? []).join(', '))} · age ${p.age ?? '?'} · rank #${p.rank}</div>
    <div class="stat" style="margin-top:10px">
      <div><b>${money(mine(p))}</b><span>your value</span></div>
      <div><b>${money(p.dollars)}</b><span>model</span></div>
      <div><b>${marketOf(p) != null ? money(marketOf(p)) : '–'}</b><span>market${p.market && !S.market[normName(p.name)] ? ` (ESPN $${Math.round(p.market)})` : ''}</span></div>
    </div>
    <h3>Projection per game (${p.projG} games)</h3>
    <div class="muted">${line('min')} min · ${line('pts')} pts · ${line('reb')} reb · ${line('ast')} ast · ${line('stl')} stl · ${line('blk')} blk · ${line('tpm')} 3pm · ${line('tov')} to ·
      FG ${(100 * p.fgm / (p.fga || 1)).toFixed(1)}% on ${line('fga')} · FT ${(100 * p.ftm / (p.fta || 1)).toFixed(1)}% on ${line('fta')}</div>
    ${base.hist ? `<div class="muted">Last season: ${Object.entries(base.hist).map(([y, h]) => `${h.team ?? ''} ${h.g}g ${(+h.min).toFixed(0)}m ${(+h.pts).toFixed(1)}p`).join(' · ')}</div>` : ''}
    ${jevSection(p)}
    <h3>Role and sources</h3>
    <div class="muted">${esc(depthLabel(p))} on the ESPN depth chart · projection: ${esc({ blend: '75% ESPN + 25% stats model', espn: 'ESPN only', model: 'stats model only', manual: 'entered by hand' }[p.source] ?? '')}</div>
    ${sourcesTable(p)}
    ${lastCascade.get(id)?.length ? `<div class="muted up">${lastCascade.get(id).map(c => `+${c.extraMin.toFixed(1)} min a game over the season while ${esc(c.cascadeFrom)} is out (${c.missed} games)`).join('<br>')}</div>` : ''}
    ${p.flags?.length ? `<div class="warn">${p.flags.map(f => `<div>⚑ ${esc(f)}</div>`).join('')}</div>` : ''}
    ${p.notes?.length ? `<div class="muted">${p.notes.map(esc).join(' ')}</div>` : ''}
    ${p.outlook ? `<details><summary class="muted">ESPN outlook</summary><div class="muted">${esc(p.outlook)}</div></details>` : ''}
    ${catChips(p)}
    <h3>Your judgement</h3>
    <div class="row">
      <div><label>$ up/down vs model</label><input id="o-d" type="number" step="1" value="${o.dollars ?? ''}" placeholder="0"></div>
      <div><label>Tag</label><select id="o-t"><option value="">–</option><option value="target" ${o.tag === 'target' ? 'selected' : ''}>Target</option><option value="avoid" ${o.tag === 'avoid' ? 'selected' : ''}>Avoid</option></select></div>
    </div>
    <div class="row" style="margin-top:8px">
      <div><label>Games (model ${base.projG ?? '?'})</label><input id="o-g" type="number" value="${o.games ?? ''}" placeholder="${base.projG ?? ''}"></div>
      <div><label>Minutes × (role change)</label><input id="o-m" type="number" step="0.05" value="${o.minutesMult ?? ''}" placeholder="1.00"></div>
    </div>
    <div style="margin-top:8px"><label>Note</label><input id="o-n" value="${esc(o.note ?? '')}" placeholder="e.g. starting PF after the trade"></div>
    <div class="row" style="margin-top:10px"><button class="btn" id="o-save">Save</button><button class="danger shrink" id="o-clear">Clear</button></div>
    ${inj ? `<h3>Injury</h3><div>${esc(inj.status)}: ${esc(inj.comment)}</div>` : ''}
    ${props.length ? `<h3>Proposed changes</h3>${props.map(proposalHtml).join('')}` : ''}
    ${heads.length ? `<h3>Headlines</h3>${heads.slice(0, 6).map(a => `<div class="news-item"><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.headline)}</a><div class="muted">${esc(a.published?.slice(0, 10))}</div></div>`).join('')}` : ''}
  `;
  $('#sheet').hidden = false;
  $('#close').onclick = closeSheet;
  $('#o-save').onclick = () => {
    const v = { dollars: $('#o-d').value, tag: $('#o-t').value, games: $('#o-g').value, minutesMult: $('#o-m').value, note: $('#o-n').value.trim() };
    const clean = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '' && x != null));
    if (Object.keys(clean).length) S.overrides[id] = clean; else delete S.overrides[id];
    save(); recompute(); closeSheet(); render();
  };
  $('#o-clear').onclick = () => { delete S.overrides[id]; save(); recompute(); closeSheet(); render(); };
  bindDecisions($('#sheetBody'), () => openPlayer(id));
}
const flagLabel = k => (FLAGS[k]?.q ?? k).replace(/^(says|describes|highlights|mentions) (that )?(the player('s)? )?/, '').replace(/^the player /, '');
function jevSection(p) {
  const flags = Object.entries(p.jevFlags ?? {}).sort((a, b) => b[1] - a[1]);
  const e = p.flagEffect;
  const moved = e && Object.entries(e).filter(([, v]) => Math.abs(v) >= (v === e.games ? 1 : 0.05));
  const tier = p.risk && riskModel?.tiers.find(t => t.name === p.risk.tier);
  if (!flags.length && !moved?.length && !tier) return '';
  return `<h3>What the news says</h3>
    ${flags.length ? `<div class="chips">${flags.map(([k, v]) => `<span class="chip" title="${esc(FLAGS[k]?.q ?? '')}">${esc(flagLabel(k))} · ${Math.round(v * 100)}%</span>`).join('')}</div>` : '<div class="muted">Jev found nothing notable in his news.</div>'}
    ${moved?.length ? `<div class="muted" style="margin-top:6px">${flagEval?.decision?.useFlags ? 'Effect of his news on the projection (fitted on four past seasons)' : 'Correction for ESPN’s usual over-projection (about 1.3 minutes a game, four seasons)'}: ${moved.map(([k, v]) => `${k === 'games' ? 'games' : k} ${v > 0 ? '+' : ''}${k === 'games' ? v : v.toFixed(2)}`).join(', ')}</div>` : ''}
    ${tier ? `<div class="muted" style="margin-top:6px">${tier.name === 'all' ? 'Uncertainty' : esc(tier.label)}: in past seasons 8 in 10 ${tier.name === 'all' ? 'drafted players' : 'players like this'} finished between ${money(tier.low)} and +${money(tier.high)} of their projection.</div>` : ''}`;
}
function sourcesTable(p) {
  const rows = [['ESPN', p.sources?.espn], ['Stats model', p.sources?.model], ['FantasyPros', p.sources?.fp]].filter(([, v]) => v);
  if (!rows.length) return '';
  return `<table style="margin-top:6px"><tr><th>Source</th><th class="num">G</th><th class="num">Min</th><th class="num">Pts</th><th class="num">Reb</th><th class="num">Ast</th></tr>
    ${rows.map(([n, v]) => `<tr><td>${n}</td><td class="num">${v.g}</td><td class="num">${(+v.min).toFixed(1)}</td><td class="num">${(+v.pts).toFixed(1)}</td><td class="num">${(+v.reb).toFixed(1)}</td><td class="num">${(+v.ast).toFixed(1)}</td></tr>`).join('')}
    <tr><td><b>Used</b></td><td class="num"><b>${p.projG}</b></td><td class="num"><b>${p.min.toFixed(1)}</b></td><td class="num"><b>${p.pts.toFixed(1)}</b></td><td class="num"><b>${p.reb.toFixed(1)}</b></td><td class="num"><b>${p.ast.toFixed(1)}</b></td></tr></table>`;
}
function closeSheet() { $('#sheet').hidden = true; }

// ---------- news & proposals ----------
function proposalHtml(a) {
  const p = byId.get(a.playerId);
  const d = S.decisions[a.id];
  const change = [a.games != null && `games → ${a.games}`, a.gamesDelta && `games ${a.gamesDelta > 0 ? '+' : ''}${a.gamesDelta}`,
    a.minutesMult && `minutes ×${a.minutesMult}`, a.minutes && `minutes → ${a.minutes}`, a.statMult && Object.entries(a.statMult).map(([k, m]) => `${k} ×${m}`).join(', ')].filter(Boolean).join(', ');
  return `<div class="news-item">
    <div><b>${esc(p?.name ?? a.name ?? a.playerId)}</b>: ${esc(change)} ${a.effect != null ? `<span class="${a.effect >= 0 ? 'up' : 'down'}">(${a.effect >= 0 ? '+' : ''}${money(a.effect)})</span>` : ''}</div>
    <div class="muted ${a.warn ? 'warn' : ''}">${esc(a.reason)}${a.source ? ` · ${esc(a.source)}` : ''}${a.date ? ` · ${esc(String(a.date).slice(0, 10))}` : ''}</div>
    <div class="row" style="margin-top:6px">
      ${d ? `<span class="muted">${d}</span><button class="ghost shrink" data-dec="${esc(a.id)}" data-v="">Undo</button>`
          : `<button class="btn shrink" data-dec="${esc(a.id)}" data-v="accepted">Accept</button><button class="ghost shrink" data-dec="${esc(a.id)}" data-v="rejected">Reject</button>`}
    </div></div>`;
}
function bindDecisions(root, after) {
  root.querySelectorAll('[data-dec]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    if (b.dataset.v) S.decisions[b.dataset.dec] = b.dataset.v; else delete S.decisions[b.dataset.dec];
    save(); recompute(); after ? after() : render();
  });
}
function pendingProposals() { return allProposals().filter(a => !S.decisions[a.id] && byId.has(a.playerId)); }

function renderNews() {
  const props = allProposals().filter(a => byId.has(a.playerId));
  // Show what each pending change would do to the player's dollars before you accept it.
  const pending = props.filter(a => !S.decisions[a.id]);
  if (pending.length <= 40) for (const a of pending) {
    const was = byId.get(a.playerId)?.dollars ?? 0;
    S.decisions[a.id] = 'accepted';
    const trial = valuesWith(allProposals());
    delete S.decisions[a.id];
    a.effect = (trial.find(p => p.id === a.playerId)?.dollars ?? 0) - was;
  }
  const decided = props.filter(a => S.decisions[a.id]);
  const inj = (news.injuries ?? []).filter(i => basePlayers().some(p => normName(p.name) === normName(i.name)));
  $('#view').innerHTML = `
    ${newsCheckPanel()}
    <div class="panel"><h2>Proposed changes (${pending.length})</h2>
      <div class="muted">From the injury report (games missed until the expected return) and from the news job. Accepting changes the player's games or minutes, and every value is recalculated.</div>
      ${pending.map(proposalHtml).join('') || '<div class="empty">Nothing waiting.</div>'}</div>
    ${decided.length ? `<div class="panel"><h2>Decided</h2>${decided.map(proposalHtml).join('')}</div>` : ''}
    <div class="panel"><h2>Depth chart moves (${(roles.changes ?? []).length})</h2><div class="muted">Each data refresh compares ESPN depth charts with the last one. A move doesn't change a value by itself: open the player and adjust minutes if you believe it.</div>
      ${[...(roles.changes ?? [])].reverse().slice(0, 40).filter(c => byId.has(c.playerId)).map(c => `<div class="news-item" data-open="${esc(c.playerId)}"><b>${esc(c.name)}</b> ${esc(c.team)}: ${esc(c.from)} → <span class="${c.promoted ? 'up' : 'down'}">${esc(c.to)}</span><div class="muted">${esc(c.date)} · projected ${(+c.projectedMin).toFixed(0)} min</div></div>`).join('') || '<div class="empty">No moves since tracking started.</div>'}</div>
    <div class="panel"><h2>Injuries (${inj.length})</h2><div class="muted">ESPN, fetched ${esc(news.fetchedAt?.slice(0, 16).replace('T', ' ') ?? 'never')}</div>
      ${inj.map(i => { const p = basePlayers().find(x => normName(x.name) === normName(i.name)); return `<div class="news-item" data-open="${esc(p.id)}"><b>${esc(i.name)}</b> <span class="tag inj">${esc(i.status)}</span><div class="muted">${esc(i.comment)}</div></div>`; }).join('')}</div>
    <div class="panel"><h2>Headlines</h2>${(news.articles ?? []).slice(0, 40).map(a => `<div class="news-item"><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.headline)}</a><div class="muted">${esc(a.published?.slice(0, 10))} · ${esc(a.description ?? '')}</div></div>`).join('') || '<div class="empty">No headlines yet.</div>'}</div>`;
  bindDecisions($('#view'));
  bindOpen($('#view'));
}

// ---------- draft room ----------
function renderDraft() {
  const D = S.draft, st = dstate();
  const me = st.teams[D.me];
  const myPlayers = me.players.map(id => byId.get(id)).filter(Boolean);
  const cur = D.current && !st.drafted.has(D.current) ? byId.get(D.current) : null;
  const options = st.board.slice(0, 400).map(p => `<option value="${esc(p.name)}">`).join('');

  let up = '';
  if (cur) {
    const adj = st.adjusted(cur);
    const ceiling = Math.min(Math.round(adj), me.maxBid);
    const rivals = st.teams.map((t, i) => ({ ...t, i })).filter(t => t.i !== D.me && t.maxBid >= ceiling).length;
    const fit = fitScore(cur, myPlayers, S.punt);
    up = `<div class="panel">
      <div class="row"><h2>${esc(cur.name)} ${tags(cur)}</h2><button class="ghost shrink" data-open="${esc(cur.id)}">Details</button></div>
      <div class="muted">${esc(cur.team)} · ${esc(cur.pos.join(','))} · ${cur.projG}g</div>
      <div class="row" style="margin-top:8px">
        <div><div class="muted">Bid up to</div><div class="bid">${money(ceiling)}</div></div>
        <div class="shrink muted" style="text-align:right">your ${money(mine(cur))} × inflation ${st.inflation.toFixed(2)}<br>model ${money(cur.dollars)}${marketOf(cur) != null ? ` · mkt ${money(marketOf(cur))}` : ''}<br>
          fit ${fit >= 0 ? '+' : ''}${fit.toFixed(1)} · ${rivals} teams can go higher</div>
      </div>
      ${catChips(cur)}
      <h3>Sold</h3>
      <div class="row"><select id="d-team">${D.teams.map((t, i) => `<option value="${i}">${esc(t)}${i === D.me ? ' (me)' : ''} · max ${money(st.teams[i].maxBid)}</option>`).join('')}</select>
        <input id="d-price" class="shrink" style="width:90px" type="number" min="1" inputmode="numeric" placeholder="$"><button class="btn shrink" id="d-sold">Sold</button></div>
    </div>`;
  }

  const best = st.board.slice(0, 12);
  // Players you don't want, or that the market prices above your value: someone else should pay for them.
  const dump = st.board.filter(p => ov(p.id).tag !== 'target' && (ov(p.id).tag === 'avoid' || (marketOf(p) ?? 0) >= st.adjusted(p) + 3))
    .sort((a, b) => (marketOf(b) ?? st.adjusted(b)) - (marketOf(a) ?? st.adjusted(a))).slice(0, 6);
  const tot = categoryTotals(myPlayers);
  const maxAbs = Math.max(3, ...CATS.map(c => Math.abs(tot[c])));

  $('#view').innerHTML = `
    <div class="panel">
      <div class="stat">
        <div><b>${st.inflation.toFixed(2)}×</b><span>inflation</span></div>
        <div><b>${money(me.left)}</b><span>my $ · max ${money(me.maxBid)}</span></div>
        <div><b>${me.slots}</b><span>my open spots</span></div>
      </div>
      <h3>Player up for bid</h3>
      <div class="row"><input id="d-search" list="d-names" placeholder="Type the nominated player" autocomplete="off"><datalist id="d-names">${options}</datalist></div>
    </div>
    ${up}
    <div class="panel"><h2>Best left (your $, inflated)</h2><div class="list">${best.map(p => playerRow(p, { right: `<div class="big">${money(st.adjusted(p))}</div><div class="small">${money(mine(p))}</div>` })).join('')}</div></div>
    <div class="panel"><h2>Nominate these</h2><div class="muted">Players you've tagged Avoid, or that the market prices above your value. Nominate them early to drain other teams' budgets.</div>
      <div class="list" style="margin-top:6px">${dump.map(p => playerRow(p, { right: `<div class="big">${money(st.adjusted(p))}</div>` })).join('') || '<div class="muted">Tag players Avoid, or import market prices in Setup, to see suggestions here.</div>'}</div></div>
    <div class="panel"><h2>My team (${myPlayers.length}/${league.rosterSize})</h2>
      ${myPlayers.map(p => `<div class="row"><span>${esc(p.name)} <span class="muted">${esc(p.pos.join(','))}</span></span><span class="shrink">${money(S.draft.picks.find(k => k.playerId === p.id).price)}</span></div>`).join('') || '<div class="muted">Nobody yet.</div>'}
      <h3>Category totals</h3>
      <div class="bars">${CATS.map(c => { const v = tot[c], w = Math.abs(v) / maxAbs * 50; return `<span>${CAT_LABEL[c]}</span><div class="bar"><i style="left:${v >= 0 ? 50 : 50 - w}%;width:${w}%;background:${v >= 0 ? 'var(--good)' : 'var(--bad)'}"></i></div><span class="num">${v.toFixed(1)}</span>`; }).join('')}</div>
    </div>
    <div class="panel"><h2>Teams</h2><table><tr><th>Team</th><th class="num">Left</th><th class="num">Spots</th><th class="num">Max bid</th></tr>
      ${st.teams.map((t, i) => `<tr class="${i === D.me ? 'me' : ''}" data-team="${i}"><td>${esc(D.teams[i])}</td><td class="num">${money(t.left)}</td><td class="num">${t.slots}</td><td class="num">${money(t.maxBid)}</td></tr>`).join('')}</table>
      <div class="muted" style="margin-top:6px">Money in the room ${money(st.money)} for ${st.slots} spots. Tap a team to see its roster.</div></div>
    <div class="panel"><h2>Pick log (${D.picks.length})</h2>
      <div class="row"><button class="ghost" id="d-undo" ${D.picks.length ? '' : 'disabled'}>Undo last</button><button class="ghost" id="d-csv">Copy CSV</button></div>
      ${[...D.picks].reverse().slice(0, 30).map(k => `<div class="news-item">${esc(byId.get(k.playerId)?.name ?? k.playerId)} → ${esc(D.teams[k.team])} ${money(k.price)}</div>`).join('')}</div>`;

  const search = $('#d-search');
  search.onchange = () => {
    const p = st.board.find(x => normName(x.name) === normName(search.value));
    if (p) { D.current = p.id; save(); render(); }
  };
  if (cur) {
    $('#d-sold').onclick = () => {
      const price = Math.round(+$('#d-price').value), team = +$('#d-team').value;
      if (!(price >= 1)) return alert('Enter the winning bid');
      if (price > st.teams[team].maxBid) return alert(`${D.teams[team]} can bid at most ${money(st.teams[team].maxBid)}`);
      D.picks.push({ playerId: cur.id, team, price, at: Date.now() });
      D.current = null; save(); render();
    };
  }
  $('#d-undo').onclick = () => { D.picks.pop(); save(); render(); };
  $('#d-csv').onclick = async () => {
    const csv = ['player,team,price', ...D.picks.map(k => `"${byId.get(k.playerId)?.name ?? k.playerId}","${D.teams[k.team]}",${k.price}`)].join('\n');
    try { await navigator.clipboard.writeText(csv); alert('Copied'); } catch { prompt('Copy:', csv); }
  };
  document.querySelectorAll('[data-team]').forEach(r => r.onclick = () => {
    const i = +r.dataset.team, t = st.teams[i];
    $('#sheetBody').innerHTML = `<div class="row"><h2>${esc(D.teams[i])}</h2><button class="ghost shrink" id="close">Close</button></div>
      <div class="muted">${money(t.left)} left · ${t.slots} spots · max bid ${money(t.maxBid)}</div>
      ${t.players.map(id => { const p = byId.get(id); return `<div class="news-item">${esc(p?.name)} <span class="muted">${esc(p?.pos?.join(','))}</span> · ${money(D.picks.find(k => k.playerId === id).price)}</div>`; }).join('')}
      <h3>Category totals</h3>${catChips({ z: categoryTotals(t.players.map(id => byId.get(id)).filter(Boolean)) }, [])}`;
    $('#sheet').hidden = false; $('#close').onclick = closeSheet;
  });
  bindOpen($('#view'));
}

// ---------- setup ----------
function parseCsv(text) {
  const rows = text.trim().split(/\r?\n/).map(l => { const out = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if ((ch === ',' || ch === '\t') && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out.map(s => s.trim()); });
  return rows;
}
function importProjections(text) {
  const rows = parseCsv(text);
  const head = rows[0].map(h => h.toUpperCase());
  const col = (...names) => head.findIndex(h => names.includes(h));
  const m = { name: col('PLAYER', 'NAME'), team: col('TEAM', 'TM'), pos: col('POS'), age: col('AGE'), g: col('G', 'GP'), min: col('MP', 'MIN', 'MPG'),
    fgm: col('FG', 'FGM'), fga: col('FGA'), tpm: col('3P', '3PM', '3PTM'), ftm: col('FT', 'FTM'), fta: col('FTA'), reb: col('TRB', 'REB'),
    ast: col('AST'), stl: col('STL', 'ST'), blk: col('BLK'), tov: col('TOV', 'TO'), pts: col('PTS') };
  const missing = Object.entries(m).filter(([k, i]) => i < 0 && !['team', 'pos', 'age', 'g'].includes(k)).map(([k]) => k);
  if (missing.length) throw new Error(`Missing columns: ${missing.join(', ')}`);
  const seen = new Set(), players = [];
  for (const r of rows.slice(1)) {
    const name = r[m.name]?.replace(/\*$/, '');
    if (!name || name.toUpperCase() === 'PLAYER' || /league average/i.test(name)) continue;
    const id = normName(name);
    if (seen.has(id)) continue; seen.add(id);
    const n = i => +r[i] || 0;
    const g = m.g >= 0 ? n(m.g) : 70;
    const p = { id, name, team: r[m.team] ?? '', age: m.age >= 0 ? n(m.age) + 1 : null, pos: String(r[m.pos] ?? '').split(/[-,/ ]+/).filter(Boolean), projG: Math.round(Math.min(78, 0.7 * g + 21)) };
    for (const k of ['min', 'fgm', 'fga', 'tpm', 'ftm', 'fta', 'reb', 'ast', 'stl', 'blk', 'tov', 'pts']) p[k] = n(m[k]);
    if (p.min >= 12) players.push(p);
  }
  return players;
}

function renderSettings() {
  const D = S.draft;
  $('#view').innerHTML = `
    <div class="panel"><h2>League</h2><div class="muted">${esc(league.name)} · ${league.teams} teams · $${league.budget} · ${league.rosterSize} players (${esc(league.rosterPositions?.join(', '))}) · 9-cat head-to-head · ${esc(league.draft)}</div>
      <div class="muted" style="margin-top:6px">Projections: ${S.importedPlayers ? `${S.importedPlayers.length} pasted players` : `${built.players?.length ?? 0} players built ${esc(built.builtAt?.slice(0, 10) ?? 'never')}`}</div></div>
    ${qualityPanel()}
    <div class="panel"><h2>Draft room</h2>
      <label>Which team is you</label><select id="s-me">${D.teams.map((t, i) => `<option value="${i}" ${i === D.me ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
      <label style="margin-top:8px">Team names, one per line (order doesn't matter)</label><textarea id="s-teams">${esc(D.teams.join('\n'))}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn" id="s-save">Save teams</button><button class="danger shrink" id="s-reset">Reset draft</button></div></div>
    <div class="panel"><h2>Market prices</h2><div class="muted">Paste "Name, $" lines, e.g. Yahoo's average auction cost from the pre-draft rankings. The gap between your value and the market is where bargains are.</div>
      <textarea id="s-market" placeholder="Nikola Jokic, 68"></textarea><div class="row" style="margin-top:8px"><button class="btn" id="s-market-go">Import ${Object.keys(S.market).length ? `(${Object.keys(S.market).length} loaded)` : ''}</button><button class="danger shrink" id="s-market-clear">Clear</button></div></div>
    <div class="panel"><h2>Paste projections</h2><div class="muted">Optional: a CSV with per-game columns (Player, Team, Pos, G, MP, FG, FGA, 3P, FT, FTA, TRB, AST, STL, BLK, TOV, PTS), e.g. Basketball Reference's "Get table as CSV" or a projections site. It replaces the built projections on this device.</div>
      <textarea id="s-proj"></textarea><div class="row" style="margin-top:8px"><button class="btn" id="s-proj-go">Use these</button><button class="danger shrink" id="s-proj-clear">Back to built data</button></div></div>
    <div class="panel"><h2>Backup</h2><div class="muted">Your ranks and draft live on this device. Copy them to move to another phone or laptop.</div>
      <div class="row" style="margin-top:8px"><button class="ghost" id="s-export">Copy backup</button><button class="ghost" id="s-import">Restore backup</button></div></div>`;
  $('#s-save').onclick = () => {
    const names = $('#s-teams').value.split('\n').map(s => s.trim()).filter(Boolean);
    if (names.length < 2) return alert('Enter the team names');
    D.teams = names; D.me = Math.min(+$('#s-me').value, names.length - 1); save(); render();
  };
  $('#s-me').onchange = e => { D.me = +e.target.value; save(); };
  document.querySelectorAll('[data-formula]').forEach(b => b.onclick = () => { S.formula = b.dataset.formula; save(); recompute(); render(); });
  $('#s-reset').onclick = () => { if (confirm('Clear every pick?')) { D.picks = []; D.current = null; save(); render(); } };
  $('#s-market-go').onclick = () => {
    let n = 0;
    for (const l of $('#s-market').value.split('\n')) { const m = /^(.+?)[,\t]\s*\$?(\d+(?:\.\d+)?)/.exec(l.trim()); if (m) { S.market[normName(m[1])] = +m[2]; n++; } }
    save(); alert(`${n} prices imported`); render();
  };
  $('#s-market-clear').onclick = () => { S.market = {}; save(); render(); };
  $('#s-proj-go').onclick = () => {
    try { const ps = importProjections($('#s-proj').value); if (ps.length < 150) throw new Error(`Only ${ps.length} players with 12+ minutes`); S.importedPlayers = ps; save(); recompute(); alert(`${ps.length} players loaded`); render(); }
    catch (e) { alert(e.message); }
  };
  $('#s-proj-clear').onclick = () => { S.importedPlayers = null; save(); recompute(); render(); };
  $('#s-export').onclick = async () => { const j = JSON.stringify({ ...S, importedPlayers: S.importedPlayers }); try { await navigator.clipboard.writeText(j); alert('Backup copied'); } catch { prompt('Copy:', j); } };
  $('#s-import').onclick = () => { const j = prompt('Paste a backup'); if (!j) return; try { S = { ...blank(), ...JSON.parse(j) }; save(); recompute(); render(); } catch { alert('That is not a backup'); } };
}

function newsCheckPanel() {
  const all = (signals?.signals ?? []).filter(x => byId.has(x.playerId));
  const list = all.filter(x => x.judge || x.kind === 'depth');
  const info = all.filter(x => !x.judge && x.kind !== 'depth');
  const fresh = list.filter(x => x.status === 'new');
  const when = d => (d ? new Date(d).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'never');
  return `<div class="panel"><h2>News check</h2>
    <div class="muted">Data refreshed ${esc(when(signals?.builtAt))} · Claude's last read ${esc(when(newsRun?.ranAt))}${newsRun?.ranAt ? `: ${newsRun.proposed} proposed, ${newsRun.skipped} skipped${newsRun.note ? ` (${esc(newsRun.note)})` : ''}` : ''}. Runs at 1:30 pm and 11 pm Eastern.</div>
    ${list.length ? `<h3>News that may matter (${fresh.length} waiting for Claude)</h3>${list.slice(0, 30).map(x => `<div class="news-item" data-open="${esc(x.playerId)}">
      <b>${esc(x.name)}</b> <span class="muted">${esc(x.team ?? '')} · ${esc(x.kind)} · ${esc(String(x.date).slice(0, 10))}</span>${x.status === 'new' ? ' <span class="tag flag">new</span>' : ''}
      <div class="muted">${esc(x.summary)}</div>${x.handledNote ? `<div class="muted">→ ${esc(x.handledNote)}</div>` : ''}</div>`).join('')}` : ''}
    ${info.length ? `<div class="muted" style="margin-top:6px">Also read: ${info.length} season outlooks and projection moves (open a player to see what Jev found).</div>` : ''}
  </div>`;
}
function qualityPanel() {
  const rows = (evalData?.summary ?? []).filter(s => s.spearman != null);
  const c = qa?.counts;
  return `<div class="panel"><h2>Data & value quality</h2>
    ${c ? `<div class="muted">Built ${esc(qa.builtAt?.slice(0, 16).replace('T', ' '))}: ${c.players} players · ${c.blended} from ESPN + stats, ${c.espnOnly} ESPN only (mostly rookies), ${c.modelOnly} stats only · ${qa.starters} starters on depth charts · ${c.flagged} with a ⚑ to check${qa.problems?.length ? ` · <b class="down">problems: ${esc(qa.problems.join('; '))}</b>` : ''}</div>` : ''}
    ${rows.length ? `<h3>Backtest: projections made before each season vs what happened</h3>
    <table><tr><th>Method</th><th class="num">Rank corr.</th><th class="num">Avg $ miss</th><th class="num">Top 50 → top 75</th></tr>
      ${rows.map(r => `<tr><td>${esc(r.label)}<div class="muted">${esc(r.seasons.map(t => `${t - 1}-${String(t).slice(2)}`).join(', '))}</div></td><td class="num">${r.spearman.toFixed(2)}</td><td class="num">$${r.maeDollars.toFixed(2)}</td><td class="num">${Math.round(r.top50StayedTop75 * 100)}%</td></tr>`).join('')}</table>
    <div class="muted" style="margin-top:6px">${esc(evalData.method)}</div>` : ''}
    ${h2h.length ? `<h3>Head-to-head test: which formula wins weeks?</h3>
    <table><tr><th>Formula</th>${h2h.map(r => `<th class="num">${r.season - 1}-${String(r.season).slice(2)}</th>`).join('')}</tr>
      ${h2h[0].results.map((row, i) => `<tr><td>${esc(row.formula)}</td>${h2h.map(r => `<td class="num">${Math.round(r.results[i].matchupWinRate * 100)}%</td>`).join('')}</tr>`).join('')}</table>
    <div class="muted" style="margin-top:6px">Weeks won by one team drafting with each formula from preseason projections against 13 teams using plain z-scores, replaying the real season's weekly stats. 50% = no better.</div>` : ''}
    ${jevTest ? `<h3>Jev reading injury notes</h3><div class="muted">${Math.round(jevTest.accuracyClear * 100)}% right on ${jevTest.perOption ? Object.values(jevTest.perOption).reduce((s, o) => s + o.examples, 0) : ''} hand-labelled notes (tested ${esc(jevTest.testedOn)}); it never said a player would miss games when the note said he wouldn't (${jevTest.missesGames.fp} false alarms, ${jevTest.missesGames.tp} of ${jevTest.missesGames.tp + jevTest.missesGames.fn} real absences caught). Its readings appear on injury proposals; nothing changes until you accept.</div>` : ''}
    ${flagEval?.decision ? `<h3>Jev's news flags: do they predict anything?</h3>
    <div class="muted">${flagTest ? `Reading: ${Math.round(flagTest.overallAccuracy * 100)}% right on hand-labelled outlooks. ` : ''}Fitted on ${esc(flagEval.seasons.map(t => `${t - 1}-${String(t).slice(2)}`).join(', '))} preseason notes, each season predicted from the others.</div>
    <table><tr><th>Projection</th><th class="num">Rank corr.</th><th class="num">Avg $ miss</th></tr>
      ${[['ESPN as is', 'espn'], ['+ ESPN’s average misses corrected', 'espnPlusBias'], ['+ Jev flag effects', 'espnPlusFlags']].map(([l, k]) => `<tr><td>${l}</td><td class="num">${flagEval.decision.mean[k].spearman.toFixed(3)}</td><td class="num">$${flagEval.decision.mean[k].mae.toFixed(2)}</td></tr>`).join('')}</table>
    <div class="muted" style="margin-top:6px">In use: ${flagEval.decision.useFlags ? 'flag effects' : flagEval.decision.useBias ? 'bias corrections only (the flags did not beat them)' : 'neither'}. Per stat: ${esc(Object.entries(flagEval.decision.choice).filter(([, c]) => c !== 'none').map(([t, c]) => `${t} ${c}`).join(', ') || 'none')}.</div>` : ''}
    <h3>Formula</h3>
    <div class="chips"><button class="chip ${S.formula !== 'z' ? 'on' : ''}" data-formula="g">G-scores (recommended)</button><button class="chip ${S.formula === 'z' ? 'on' : ''}" data-formula="z">Plain z-scores</button></div>
  </div>`;
}

// ---------- shell ----------
function render() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  const pend = pendingProposals().length;
  $('#newsBadge').hidden = !pend; $('#newsBadge').textContent = pend;
  $('#meta').textContent = S.punt.length ? `punting ${S.punt.map(c => CAT_LABEL[c]).join(', ')}` : '';
  ({ ranks: renderRanks, draft: renderDraft, news: renderNews, settings: renderSettings })[tab]();
}

init();
