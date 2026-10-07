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
let tab = ['prep', 'board', 'yahoo', 'news', 'draft'].includes(S.tab) ? S.tab : 'prep';
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
  document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => go(b.dataset.tab));
  $('#settingsBtn').onclick = openSettings;
  $('#sheet').onclick = e => { if (e.target.id === 'sheet') closeSheet(); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
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

// ---------- pasted projections ----------
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

// ======================================================================================
// Screens. Each one opens with what it's for and what to do; the journey is
// Prep (what's next) → Board (set your prices) → Yahoo (copy them in) → News → Draft.
// ======================================================================================
const DRAFT_DATE = new Date('2026-10-18T19:00:00-04:00');
const YAHOO_DEFAULT_COUNT = 150;
const TITLES = {
  prep: ['Prep', 'Get ready for the 18 Oct auction'],
  board: ['Your board', 'Your price for every player'],
  yahoo: ['Set values in Yahoo', 'Copy your prices into Yahoo'],
  news: ['News', 'Changes that could move a price'],
  draft: ['Live draft', 'For draft night'],
};

const toast = msg => { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2200); };
const daysToDraft = () => Math.ceil((DRAFT_DATE - Date.now()) / 864e5);
const edited = p => Object.keys(ov(p.id)).length > 0;
const drafted = () => new Set(S.draft.picks.map(p => p.playerId));

// Deal: your price against what the Yahoo room is likely to pay (on this league's scale).
function deal(p) {
  const m = mine(p), mk = marketOf(p);
  if (mk == null) return { kind: 'none', diff: 0, mk: null };
  const diff = m - mk;
  const kind = diff >= 4 && m >= 4 ? 'bargain' : diff <= -4 && mk >= 4 ? 'pricey' : 'fair';
  return { kind, diff, mk };
}
function dealChip(p) {
  const d = deal(p);
  if (d.kind === 'none') return `<span class="deal fair">Yahoo $0–1</span>`;
  return `<span class="deal ${d.kind}" title="${d.kind}">Yahoo ${money(d.mk)}</span>`;
}
// Best and worst categories in a few words, instead of nine chips.
function strengths(p) {
  const zs = CATS.filter(c => !S.punt.includes(c)).map(c => [c, p.z?.[c] ?? 0]).sort((a, b) => b[1] - a[1]);
  const good = zs.filter(([, z]) => z >= 0.7).slice(0, 3).map(([c]) => CAT_LABEL[c]);
  const weak = zs.filter(([, z]) => z <= -0.9).slice(-2).map(([c]) => CAT_LABEL[c]);
  return [good.length ? `<span class="good">${good.join(' ')}</span>` : '', weak.length ? `<span class="weak">weak ${weak.join(' ')}</span>` : ''].filter(Boolean).join(' · ');
}
function pills(p) {
  const o = ov(p.id), inj = injuryOf(p);
  return `${o.tag === 'target' ? '<span class="pill target">TARGET</span>' : o.tag === 'avoid' ? '<span class="pill avoid">AVOID</span>' : ''}${inj ? `<span class="pill inj">${esc(shortStatus(inj.status))}</span>` : p.injury ? `<span class="pill inj">${esc(shortStatus(p.injury))}</span>` : ''}`;
}
const shortStatus = s => ({ 'Day-To-Day': 'DTD', DAY_TO_DAY: 'DTD', Out: 'OUT', OUT: 'OUT', Questionable: 'Q', QUESTIONABLE: 'Q', SUSPENSION: 'SUSP' }[s] ?? String(s).slice(0, 4).toUpperCase());

function playerRow(p, { right, gone, rank } = {}) {
  const meta = [esc(p.team ?? ''), esc((p.pos ?? []).join('/')), `${(p.min ?? 0).toFixed(0)} min`].filter(Boolean).join(' · ');
  const s = strengths(p);
  return `<button class="prow ${gone ? 'gone' : ''}" data-open="${esc(p.id)}">
    <div class="rk">${rank ?? p.rank}</div>
    <div class="who"><div class="nm">${esc(p.name)}${pills(p)}</div><div class="meta">${meta}${s ? ` · ${s}` : ''}</div></div>
    <div class="px">${right ?? `<div class="price ${edited(p) && (+ov(p.id).dollars || 0) ? 'edited' : ''}">${money(mine(p))}</div>${dealChip(p)}`}</div>
  </button>`;
}
const bindOpen = root => root.querySelectorAll('[data-open]').forEach(el => el.onclick = () => openPlayer(el.dataset.open));

// ---------- Prep: what's next ----------
function renderPrep() {
  const top = boardOrder().slice(0, S.yahooCount ?? YAHOO_DEFAULT_COUNT);
  const done = top.filter(p => yahooState(p) === 'done').length;
  const nEdited = ranked.filter(edited).length, nTargets = ranked.filter(p => ov(p.id).tag === 'target').length;
  const waiting = pendingProposals().length;
  const teamsNamed = S.draft.teams.some(t => !/^Team \d+$/.test(t));
  const days = daysToDraft();
  const steps = [
    { tab: 'board', t: 'Review your board', d: nEdited ? `${nEdited} prices adjusted · ${nTargets} targets tagged` : 'Change any price you disagree with and tag the players you want', done: nEdited >= 5 },
    { tab: 'yahoo', t: 'Set your values in Yahoo', d: `${done} of ${top.length} entered`, done: done >= top.length, progress: done / top.length },
    { tab: 'news', t: 'Check the news', d: waiting ? `${waiting} change${waiting > 1 ? 's' : ''} waiting for your OK` : 'Nothing waiting', done: !waiting },
    { tab: 'settings', t: 'Set up draft night', d: teamsNamed ? 'Team names entered' : 'Enter the 14 team names so the app can track budgets', done: teamsNamed },
  ];
  const next = steps.findIndex(s => !s.done);
  // What the Yahoo room is likely to get wrong, from your values against Yahoo's average prices.
  const withMkt = ranked.filter(p => marketOf(p) != null);
  const overpay = [...withMkt].filter(p => marketOf(p) - mine(p) >= 6).sort((a, b) => (marketOf(b) - mine(b)) - (marketOf(a) - mine(a))).slice(0, 5);
  const bargains = [...withMkt].filter(p => mine(p) >= 8 && mine(p) - marketOf(p) >= 5).sort((a, b) => (mine(b) - marketOf(b)) - (mine(a) - marketOf(a))).slice(0, 6);
  $('#view').innerHTML = `
    <div class="card hero">
      <div class="big">${days > 1 ? `${days} days` : days === 1 ? 'Tomorrow' : days === 0 ? 'Today' : 'Draft done'}</div>
      <div class="meta">until the auction · 14 teams · $200 each · 9-cat head-to-head</div>
    </div>
    <div class="section-title">Your checklist</div>
    <div class="steps">${steps.map((s, i) => `<button class="step ${s.done ? 'done' : ''} ${i === next ? 'next' : ''}" data-go="${s.tab}">
      <div class="n">${s.done ? '✓' : i + 1}</div>
      <div><div class="t">${s.t}</div><div class="d">${s.d}</div>${s.progress != null ? `<div class="progress"><i style="width:${Math.round(s.progress * 100)}%"></i></div>` : ''}</div>
      <div class="go">›</div></button>`).join('')}</div>
    ${overpay.length ? `<div class="section-title">Let others pay for these</div>
    <div class="card"><div class="sub" style="margin-bottom:6px">The Yahoo room usually pays well over what they're worth in your 9-cat league. Nominate them early.</div>
      ${overpay.map(p => `<div class="mini" data-open="${esc(p.id)}"><div class="nm">${esc(p.name)}</div><div class="r"><b class="down">Yahoo ~${money(marketOf(p))}</b></div><div class="muted">${esc(p.team)} · ${strengths(p) || esc((p.pos ?? []).join('/'))}</div><div class="r muted">yours ${money(mine(p))}</div></div>`).join('')}</div>` : ''}
    ${bargains.length ? `<div class="section-title">Bargains to target</div>
    <div class="card"><div class="sub" style="margin-bottom:6px">Worth more to you than the Yahoo room usually pays.</div>
      ${bargains.map(p => `<div class="mini" data-open="${esc(p.id)}"><div class="nm">${esc(p.name)}</div><div class="r"><b class="up">yours ${money(mine(p))}</b></div><div class="muted">${esc(p.team)} · ${strengths(p) || esc((p.pos ?? []).join('/'))}</div><div class="r muted">Yahoo ~${money(marketOf(p))}</div></div>`).join('')}</div>` : ''}
    <div class="muted" style="text-align:center;margin-top:16px">Data updated ${esc(when(built.builtAt))} · refreshes 1:30 pm and 11 pm ET</div>`;
  document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => (b.dataset.go === 'settings' ? openSettings() : go(b.dataset.go)));
  bindOpen($('#view'));
}
const when = d => (d ? new Date(d).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'never');

// ---------- Board: your prices ----------
const boardOrder = () => [...ranked].sort((a, b) => mine(b) - mine(a) || b.value - a.value);
const BOARD_VIEWS = [['all', 'All'], ['bargain', 'Bargains'], ['pricey', 'Pricey'], ['target', 'Targets'], ['avoid', 'Avoid'], ['edited', 'Changed'], ['open', 'Undrafted']];
function renderBoard() {
  const f = S.filters;
  const gone = drafted();
  const all = boardOrder();
  const yourRank = new Map(all.map((p, i) => [p.id, i + 1]));
  const match = {
    all: () => true, bargain: p => deal(p).kind === 'bargain', pricey: p => deal(p).kind === 'pricey', target: p => ov(p.id).tag === 'target',
    avoid: p => ov(p.id).tag === 'avoid', edited, open: p => !gone.has(p.id),
  };
  const counts = Object.fromEntries(BOARD_VIEWS.map(([k]) => [k, all.filter(match[k]).length]));
  let list = all.filter(match[f.show] ?? match.all);
  if (f.pos !== 'All') list = list.filter(p => (p.pos ?? []).includes(f.pos));
  if (f.q) list = list.filter(p => normName(p.name).includes(normName(f.q)));
  const shown = list.slice(0, f.q ? 60 : 250);
  let lastTier = 0;
  const tierRange = t => ({ 1: '$50+', 2: '$38–49', 3: '$27–37', 4: '$18–26', 5: '$10–17', 6: '$4–9', 7: '$1–3', 8: '$0' }[t]);
  $('#view').innerHTML = `
    <div class="filters">
      <div class="row"><input class="grow" id="q" type="search" placeholder="Find a player" value="${esc(f.q)}" autocomplete="off">
        <select id="pos" style="width:auto">${['All', 'PG', 'SG', 'SF', 'PF', 'C'].map(x => `<option ${x === f.pos ? 'selected' : ''}>${x === 'All' ? 'All pos' : x}</option>`).join('')}</select></div>
      <div class="seg">${BOARD_VIEWS.filter(([k]) => k !== 'open' || S.draft.picks.length).map(([k, l]) => `<button class="chip ${f.show === k ? 'on' : ''}" data-show="${k}">${l}${k !== 'all' && counts[k] ? `<span class="ct">${counts[k]}</span>` : ''}</button>`).join('')}
        <button class="chip" id="strategy">Strategy ▾</button></div>
    </div>
    <p class="intro">Big number: what he's worth to <b>your</b> team. Below it, what Yahoo drafters usually pay: <b class="up">green</b> means a bargain, <b class="down">red</b> means pricey. Tap a player to change his price.</p>
    ${S.punt.length ? `<div class="notice"><span>Punting ${S.punt.map(c => CAT_LABEL[c]).join(', ')}: those categories don't count in prices.</span><button id="unpunt">Undo</button></div>` : ''}
    ${!ranked.length ? '<div class="empty">No projections yet. The data refresh fills them in.</div>' : ''}
    ${!shown.length && ranked.length ? '<div class="empty">No players match.</div>' : ''}
    <div class="list">${shown.map(p => {
      const t = tierOf(mine(p));
      const head = t !== lastTier && !f.q && f.show === 'all' ? `<div class="tier"><span>Tier ${t}</span><span>${tierRange(t)}</span></div>` : '';
      lastTier = t;
      return head + playerRow(p, { gone: gone.has(p.id), rank: yourRank.get(p.id) });
    }).join('')}</div>`;
  $('#q').oninput = e => { f.q = e.target.value; save(); keepFocus(renderBoard, '#q'); };
  $('#pos').onchange = e => { f.pos = e.target.value; save(); render(); };
  document.querySelectorAll('[data-show]').forEach(b => b.onclick = () => { f.show = b.dataset.show; save(); render(); });
  $('#strategy').onclick = openStrategy;
  if ($('#unpunt')) $('#unpunt').onclick = () => { S.punt = []; save(); recompute(); render(); };
  bindOpen($('#view'));
}
function keepFocus(fn, sel) { const el = $(sel), pos = el.selectionStart; fn(); const n = $(sel); n.focus(); n.setSelectionRange(pos, pos); }

function openStrategy() {
  sheet(`<div class="sheet-head"><div><h2>Strategy</h2><div class="muted">Change how every price is worked out</div></div><button class="close" data-close>✕</button></div>
    <div class="section-title">Punt categories</div>
    <div class="muted">Planning to give up a category every week (say FT% with Giannis)? Tap it and prices ignore it.</div>
    <div class="seg" style="flex-wrap:wrap">${CATS.map(c => `<button class="chip ${S.punt.includes(c) ? 'punted' : ''}" data-punt="${c}">${CAT_LABEL[c]}</button>`).join('')}</div>
    <div class="section-title">Pricing formula</div>
    <div class="seg"><button class="chip ${S.formula !== 'z' ? 'on' : ''}" data-formula="g">Head-to-head (recommended)</button><button class="chip ${S.formula === 'z' ? 'on' : ''}" data-formula="z">Season totals</button></div>
    <div class="muted" style="margin-top:8px">Head-to-head pricing won 61–66% of weeks against season-total pricing when replaying the last three seasons.</div>
    <button class="btn block" style="margin-top:18px" data-close>Done</button>`);
  document.querySelectorAll('[data-punt]').forEach(b => b.onclick = () => {
    const c = b.dataset.punt;
    S.punt = S.punt.includes(c) ? S.punt.filter(x => x !== c) : [...S.punt, c];
    save(); recompute(); render(); openStrategy();
  });
  document.querySelectorAll('[data-formula]').forEach(b => b.onclick = () => { S.formula = b.dataset.formula; save(); recompute(); render(); openStrategy(); });
}

// ---------- Player sheet: change his price first, reasons below ----------
function setOverride(id, patch) {
  const o = { ...ov(id), ...patch };
  for (const k of Object.keys(o)) if (o[k] === '' || o[k] == null || (k === 'dollars' && +o[k] === 0)) delete o[k];
  if (Object.keys(o).length) S.overrides[id] = o; else delete S.overrides[id];
  save(); recompute(); render();
}
function verdict(p) {
  const d = deal(p);
  if (d.kind === 'none') return 'Yahoo has no average price for him: he usually goes for $1 or undrafted.';
  if (d.kind === 'bargain') return `The Yahoo room usually pays about <b>${money(d.mk)}</b>, ${money(d.diff)} less than he's worth to you. <b class="up">A bargain to target.</b>`;
  if (d.kind === 'pricey') return `The Yahoo room usually pays about <b>${money(d.mk)}</b>, ${money(-d.diff)} more than he's worth to you. <b class="down">Let someone else overpay.</b>`;
  return `The Yahoo room usually pays about <b>${money(d.mk)}</b>, close to your price.`;
}
function catBars(p) {
  const max = Math.max(2.5, ...CATS.map(c => Math.abs(p.z?.[c] ?? 0)));
  return `<div class="bars">${CATS.map(c => {
    const z = p.z?.[c] ?? 0, w = (Math.abs(z) / max) * 50;
    return `<span class="lab ${S.punt.includes(c) ? 'punted' : ''}">${CAT_LABEL[c]}</span><div class="bar"><i style="left:${z >= 0 ? 50 : 50 - w}%;width:${w}%;background:${z >= 0 ? 'var(--good)' : 'var(--bad)'}"></i></div><span class="v">${z > 0 ? '+' : ''}${z.toFixed(1)}</span>`;
  }).join('')}</div>`;
}
function openPlayer(id) {
  const p = byId.get(id);
  if (!p) return;
  const o = ov(id), base = basePlayers().find(x => x.id === id) ?? {};
  const props = allProposals().filter(a => a.playerId === id && byId.has(a.playerId));
  const inj = injuryOf(p);
  const heads = (news.articles ?? []).filter(a => a.athletes?.some(n => normName(n) === normName(p.name)) || normName(a.headline).includes(normName(p.name)));
  const line = k => (p[k] ?? 0).toFixed(1);
  const cas = lastCascade.get(id) ?? [];
  sheet(`
    <div class="sheet-head"><div><h2>${esc(p.name)}${pills(p)}</h2><div class="muted">${esc(p.team)} · ${esc((p.pos ?? []).join('/'))} · ${p.age ? `age ${p.age} · ` : ''}${esc(depthLabel(p))}</div></div><button class="close" data-close aria-label="Close">✕</button></div>
    <div class="card pricecard" style="margin-top:12px">
      <div class="muted">Your price</div>
      <div class="stepper"><button id="minus" aria-label="Lower by $1">−</button><div class="val">${money(mine(p))}</div><button id="plus" aria-label="Raise by $1">+</button></div>
      <div class="muted">${+o.dollars ? `Model says ${money(p.dollars)} · you've moved it ${+o.dollars > 0 ? '+' : ''}${money(+o.dollars)} · <a href="#" id="resetPrice">reset</a>` : `Model price · #${p.rank} overall`}</div>
      <div class="verdict">${verdict(p)}</div>
      <div class="toggles"><button class="toggle target ${o.tag === 'target' ? 'on' : ''}" id="tTarget">★ Target</button><button class="toggle avoid ${o.tag === 'avoid' ? 'on' : ''}" id="tAvoid">✕ Avoid</button></div>
    </div>
    ${props.length ? `<div class="section-title">News waiting for you</div>${props.map(proposalCard).join('')}` : ''}
    ${cas.length ? `<div class="muted up" style="margin:4px 2px 10px">${cas.map(c => `+${c.extraMin.toFixed(1)} min a game while ${esc(c.cascadeFrom)} is out`).join('<br>')}</div>` : ''}
    <div class="section-title">Why this price</div>
    <div class="card">
      <div class="muted" style="margin-bottom:10px">Each bar is how much he helps (+) or hurts (−) you in that category, per game.</div>
      ${catBars(p)}
      <div class="kv"><div><b>${p.projG}</b><span>games</span></div><div><b>${line('min')}</b><span>minutes</span></div><div><b>${line('pts')}</b><span>points</span></div></div>
      <div class="muted" style="margin-top:10px">${line('reb')} reb · ${line('ast')} ast · ${line('stl')} stl · ${line('blk')} blk · ${line('tpm')} 3pm · ${line('tov')} to · FG ${(100 * p.fgm / (p.fga || 1)).toFixed(1)}% · FT ${(100 * p.ftm / (p.fta || 1)).toFixed(1)}%</div>
      ${p.risk ? `<div class="muted" style="margin-top:8px">Most players finish within ${money(p.risk.low)} / +${money(p.risk.high)} of their price.</div>` : ''}
    </div>
    ${inj || heads.length ? `<div class="section-title">Latest</div><div class="card">${inj ? `<div class="item"><span class="pill inj" style="margin:0 6px 0 0">${esc(shortStatus(inj.status))}</span>${esc(inj.comment)}</div>` : ''}${heads.slice(0, 4).map(a => `<div class="item"><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.headline)}</a><div class="muted">${esc(a.published?.slice(0, 10))}</div></div>`).join('')}</div>` : ''}
    <details class="more"><summary>Adjust his projection</summary><div class="inner">
      <div class="muted">For news the app hasn't caught. Values recalculate as you type.</div>
      <div class="row"><div class="grow"><label>Games (now ${base.projG ?? '?'})</label><input id="o-g" type="number" inputmode="numeric" value="${o.games ?? ''}" placeholder="${base.projG ?? ''}"></div>
        <div class="grow"><label>Minutes × (e.g. 1.15)</label><input id="o-m" type="number" step="0.05" inputmode="decimal" value="${o.minutesMult ?? ''}" placeholder="1.00"></div></div>
      <label>Note to yourself</label><input id="o-n" value="${esc(o.note ?? '')}" placeholder="e.g. named the starter">
    </div></details>
    <details class="more"><summary>Where the numbers come from</summary><div class="inner">
      ${sourcesTable(p)}
      ${p.yahoo ? `<div class="muted" style="margin-top:8px">Yahoo: rank #${p.yahoo.rank}, average auction price $${p.yahoo.avg} in Yahoo leagues (mostly 10–12 teams), shown here on your league's scale. Yahoo's own projected value: $${p.yahoo.proj}.</div>` : ''}
      ${Object.keys(p.jevFlags ?? {}).length ? `<div class="muted" style="margin-top:8px">News reading: ${Object.entries(p.jevFlags).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(flagLabel(k))} (${Math.round(v * 100)}%)`).join('; ')}.</div>` : ''}
      ${p.flags?.length ? `<div class="muted warn-ink" style="margin-top:8px">${p.flags.map(esc).join('<br>')}</div>` : ''}
      ${p.notes?.length ? `<div class="muted" style="margin-top:8px">${p.notes.map(esc).join(' ')}</div>` : ''}
      ${p.outlook ? `<div class="muted" style="margin-top:8px"><b>ESPN outlook.</b> ${esc(p.outlook)}</div>` : ''}
    </div></details>`);
  const step = d => setOverride(id, { dollars: (+ov(id).dollars || 0) + d }) || openPlayer(id);
  $('#minus').onclick = () => { if (mine(p) > 0) step(-1); };
  $('#plus').onclick = () => step(1);
  if ($('#resetPrice')) $('#resetPrice').onclick = e => { e.preventDefault(); setOverride(id, { dollars: '' }); openPlayer(id); };
  $('#tTarget').onclick = () => { setOverride(id, { tag: o.tag === 'target' ? '' : 'target' }); openPlayer(id); };
  $('#tAvoid').onclick = () => { setOverride(id, { tag: o.tag === 'avoid' ? '' : 'avoid' }); openPlayer(id); };
  for (const [sel, k] of [['#o-g', 'games'], ['#o-m', 'minutesMult'], ['#o-n', 'note']]) $(sel).onchange = e => setOverride(id, { [k]: e.target.value.trim() });
  bindDecisions($('#sheetBody'), () => openPlayer(id));
}
const flagLabel = k => (FLAGS[k]?.q ?? k).replace(/^(says|describes|highlights|mentions) (that )?(the player('s)? )?/, '').replace(/^the player /, '');
const depthLabel = p => (p.depth ? (p.depth.starter ? `starter at ${p.depth.pos}` : `${p.depth.pos} depth #${p.depth.rank}`) : 'no depth chart slot');
function sourcesTable(p) {
  const rows = [['ESPN', p.sources?.espn], ['Stats model', p.sources?.model], ['FantasyPros', p.sources?.fp]].filter(([, v]) => v);
  if (!rows.length) return '<div class="muted">Entered by hand.</div>';
  return `<div class="muted" style="margin-bottom:6px">Projection: ${esc({ blend: '75% ESPN + 25% stats model', espn: 'ESPN only', model: 'stats model only', manual: 'entered by hand' }[p.source] ?? '')}</div>
    <table><tr><th>Source</th><th class="num">G</th><th class="num">Min</th><th class="num">Pts</th><th class="num">Reb</th><th class="num">Ast</th></tr>
    ${rows.map(([n, v]) => `<tr><td>${n}</td><td class="num">${v.g}</td><td class="num">${(+v.min).toFixed(1)}</td><td class="num">${(+v.pts).toFixed(1)}</td><td class="num">${(+v.reb).toFixed(1)}</td><td class="num">${(+v.ast).toFixed(1)}</td></tr>`).join('')}
    <tr><td><b>Used</b></td><td class="num"><b>${p.projG}</b></td><td class="num"><b>${p.min.toFixed(1)}</b></td><td class="num"><b>${p.pts.toFixed(1)}</b></td><td class="num"><b>${p.reb.toFixed(1)}</b></td><td class="num"><b>${p.ast.toFixed(1)}</b></td></tr></table>`;
}

// ---------- Yahoo: copy your prices in ----------
// A player is 'done' when you ticked him and his price hasn't moved since; 'stale' if it moved.
function yahooState(p) {
  const v = S.yahooDone?.[p.id];
  if (v == null) return 'todo';
  return Math.abs(v - Math.round(mine(p))) >= 1 ? 'stale' : 'done';
}
function renderYahoo() {
  S.yahooDone ??= {};
  const count = S.yahooCount ?? YAHOO_DEFAULT_COUNT;
  const top = boardOrder().slice(0, count);
  const yahooDefault = p => p.yahoo?.proj ?? 0; // outside Yahoo's top 150: about $0
  const change = p => (yahooDefault(p) == null ? Infinity : Math.abs(Math.round(mine(p)) - yahooDefault(p)));
  const sort = S.yahooSort ?? 'change';
  const order = sort === 'change' ? [...top].sort((a, b) => change(b) - change(a)) : top;
  const done = top.filter(p => yahooState(p) === 'done').length, stale = top.filter(p => yahooState(p) === 'stale').length;
  const show = S.yahooShow ?? 'todo';
  const rows = order.filter(p => show === 'all' || yahooState(p) !== 'done');
  $('#view').innerHTML = `
    <div class="card">
      <h2>${done} of ${top.length} entered</h2>
      <div class="progress"><i style="width:${Math.round((done / top.length) * 100)}%"></i></div>
      ${stale ? `<div class="muted warn-ink" style="margin-top:8px">${stale} price${stale > 1 ? 's' : ''} changed since you entered ${stale > 1 ? 'them' : 'it'}: re-enter the new value.</div>` : ''}
      <ol class="howto">
        <li><span>Open Yahoo Fantasy → your league → <b>Draft</b> → <b>Pre-Draft Rankings</b> → Edit.</span></li>
        <li><span>For each player below, change Yahoo's value <span class="muted">(crossed out)</span> to <b>your value</b>. Biggest changes are first.</span></li>
        <li><span>Tick him off here. Your list is saved on this phone.</span></li>
      </ol>
      <div class="muted">Yahoo's values here come from its Draft Analysis page. If your league shows a different number, just enter yours. If Yahoo only lets you reorder, use "Your order".</div>
    </div>
    <div class="seg">
      <button class="chip ${sort === 'change' ? 'on' : ''}" data-ysort="change">Biggest changes</button>
      <button class="chip ${sort === 'order' ? 'on' : ''}" data-ysort="order">Your order</button>
      <button class="chip ${show === 'all' ? 'on' : ''}" data-yshow="${show === 'all' ? 'todo' : 'all'}">${show === 'all' ? 'Hide entered' : 'Show entered'}</button>
      <select id="ycount" style="width:auto;min-height:36px;padding:6px 10px">${[100, 150, 182].map(n => `<option value="${n}" ${n === count ? 'selected' : ''}>Top ${n}</option>`).join('')}</select>
    </div>
    <div class="list" style="margin-top:10px">${rows.map(p => {
      const st = yahooState(p), y = yahooDefault(p), m = Math.round(mine(p));
      const same = y != null && Math.abs(m - y) < 1;
      return `<div class="yrow ${st}">
        <button class="check" data-ytick="${esc(p.id)}" aria-label="${st === 'done' ? 'Untick' : 'Tick'} ${esc(p.name)}"><i></i></button>
        <div class="who" data-open="${esc(p.id)}"><div class="nm" style="font-weight:650">${esc(p.name)}</div><div class="meta muted">#${top.indexOf(p) + 1} on your board · ${esc(p.team)} · ${esc((p.pos ?? []).join('/'))}${st === 'stale' ? ` · <span class="warn-ink">was ${money(S.yahooDone[p.id])}</span>` : ''}</div></div>
        <div class="ychange">${same ? `<span class="to">${money(m)}</span><div class="muted small">same as Yahoo</div>` : `${y != null ? `<span class="from">$${y}</span>` : ''}<span class="to">${money(m)}</span>`}</div>
      </div>`;
    }).join('') || '<div class="empty">All entered. Nice. New price changes will reappear here.</div>'}</div>
    <button class="btn secondary block" id="ycopy" style="margin-top:14px">Copy the list as text</button>`;
  document.querySelectorAll('[data-ytick]').forEach(b => b.onclick = () => {
    const id = b.dataset.ytick, p = byId.get(id);
    if (yahooState(p) === 'done') delete S.yahooDone[id]; else S.yahooDone[id] = Math.round(mine(p));
    save(); render();
  });
  document.querySelectorAll('[data-ysort]').forEach(b => b.onclick = () => { S.yahooSort = b.dataset.ysort; save(); render(); });
  document.querySelectorAll('[data-yshow]').forEach(b => b.onclick = () => { S.yahooShow = b.dataset.yshow; save(); render(); });
  $('#ycount').onchange = e => { S.yahooCount = +e.target.value; save(); render(); };
  $('#ycopy').onclick = () => copyText(top.map((p, i) => `${i + 1}. ${p.name} $${Math.round(mine(p))}`).join('\n'), 'List copied');
  bindOpen($('#view'));
}
async function copyText(t, msg) { try { await navigator.clipboard.writeText(t); toast(msg); } catch { prompt('Copy:', t); } }

// ---------- News: decisions waiting for you ----------
function describe(a) {
  const parts = [];
  if (a.games != null) parts.push(a.games === 0 ? 'Out for the season' : `Plays ${a.games} games`);
  if (a.gamesDelta) parts.push(a.gamesDelta < 0 ? `Misses about ${-a.gamesDelta} games` : `Plays ${a.gamesDelta} more games`);
  if (a.minutes) parts.push(`${a.minutes} minutes a game`);
  if (a.minutesMult) parts.push(`${a.minutesMult > 1 ? 'More' : 'Fewer'} minutes (×${a.minutesMult})`);
  if (a.statMult) parts.push(`Bigger role: ${Object.entries(a.statMult).map(([k, m]) => `${k} ×${m}`).join(', ')}`);
  return parts.join(' · ');
}
function proposalCard(a) {
  const p = byId.get(a.playerId), d = S.decisions[a.id];
  const now = p ? mine(p) : 0;
  const reason = String(a.reason ?? '').replace(/Jev reads[^.]*\.\s*/g, '').replace(/\s*The note and the date disagree: check before accepting\./, '');
  return `<div class="ncard ${a.warn && !d ? 'warned' : ''}">
    <div class="head"><span class="nm" data-open="${esc(a.playerId)}">${esc(p?.name ?? a.name ?? '')}</span>${a.effect != null && !d ? `<span class="effect ${a.effect >= 0 ? 'up' : 'down'}">${money(now)} → ${money(now + a.effect)}</span>` : ''}</div>
    <div class="what">${esc(describe(a))}</div>
    <div class="why">${esc(reason)}${a.warn ? ' <span class="warn-ink">The report and the note disagree: check before accepting.</span>' : ''}${a.date ? ` · ${esc(String(a.date).slice(0, 10))}` : ''}</div>
    <div class="acts">${d ? `<span class="muted grow" style="flex:1;align-self:center">${d === 'accepted' ? '✓ Applied to his price' : 'Ignored'}</span><button class="btn quiet" data-dec="${esc(a.id)}" data-v="">Undo</button>`
      : `<button class="btn" data-dec="${esc(a.id)}" data-v="accepted">Apply</button><button class="btn secondary" data-dec="${esc(a.id)}" data-v="rejected">Ignore</button>`}</div>
  </div>`;
}
function bindDecisions(root, after) {
  root.querySelectorAll('[data-dec]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    if (b.dataset.v) S.decisions[b.dataset.dec] = b.dataset.v; else delete S.decisions[b.dataset.dec];
    save(); recompute(); render(); if (after) after();
  });
  root.querySelectorAll('.ncard [data-open]').forEach(el => el.onclick = () => openPlayer(el.dataset.open));
}
function pendingProposals() { return allProposals().filter(a => !S.decisions[a.id] && byId.has(a.playerId)); }
function renderNews() {
  const props = allProposals().filter(a => byId.has(a.playerId));
  const pending = props.filter(a => !S.decisions[a.id]);
  // What each pending change would do to his price, before you apply it.
  if (pending.length <= 40) for (const a of pending) {
    const was = byId.get(a.playerId)?.dollars ?? 0;
    S.decisions[a.id] = 'accepted';
    const trial = valuesWith(allProposals());
    delete S.decisions[a.id];
    a.effect = (trial.find(p => p.id === a.playerId)?.dollars ?? 0) - was;
  }
  pending.sort((x, y) => Math.abs(y.effect ?? 0) - Math.abs(x.effect ?? 0));
  const decided = props.filter(a => S.decisions[a.id]);
  const moves = [...(roles.changes ?? [])].reverse().filter(c => byId.has(c.playerId)).slice(0, 25);
  const inj = (news.injuries ?? []).map(i => [i, basePlayers().find(x => normName(x.name) === normName(i.name))]).filter(([, p]) => p && byId.get(p.id)?.rank <= 250);
  $('#view').innerHTML = `
    <p class="intro">News that changes how many games or minutes a player gets. <b>Apply</b> the ones you believe and his price updates; teammates who pick up his minutes update too.</p>
    <div class="section-title">Waiting for you · ${pending.length}</div>
    ${pending.map(proposalCard).join('') || '<div class="card empty">Nothing waiting. New news is checked twice a day.</div>'}
    ${moves.length ? `<details class="more"><summary>Lineup changes · ${moves.length}</summary><div class="inner">${moves.map(c => `<div class="item" data-open="${esc(c.playerId)}"><b>${esc(c.name)}</b> <span class="muted">${esc(c.team)}</span><div class="muted">${esc(c.from)} → <span class="${c.promoted ? 'up' : 'down'}">${esc(c.to)}</span> · ${esc(c.date)}</div></div>`).join('')}<div class="muted" style="margin-top:6px">Moves on ESPN's depth charts. They don't change a price by themselves: open the player and adjust his minutes if you believe it.</div></div></details>` : ''}
    ${inj.length ? `<details class="more"><summary>Injury report · ${inj.length}</summary><div class="inner">${inj.map(([i, p]) => `<div class="item" data-open="${esc(p.id)}"><b>${esc(i.name)}</b> <span class="pill inj">${esc(shortStatus(i.status))}</span><div class="muted">${esc(i.comment)}</div></div>`).join('')}</div></details>` : ''}
    ${(news.articles ?? []).length ? `<details class="more"><summary>Headlines · ${Math.min(40, news.articles.length)}</summary><div class="inner">${news.articles.slice(0, 40).map(a => `<div class="item"><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.headline)}</a><div class="muted">${esc(a.published?.slice(0, 10))}</div></div>`).join('')}</div></details>` : ''}
    ${decided.length ? `<details class="more"><summary>Already decided · ${decided.length}</summary><div class="inner">${decided.map(proposalCard).join('')}</div></details>` : ''}
    <div class="muted" style="text-align:center;margin-top:12px">Checked ${esc(when(signals?.builtAt ?? news.fetchedAt))} · next at 1:30 pm or 11 pm ET</div>`;
  bindDecisions($('#view'));
  bindOpen($('#view'));
}

// ---------- Draft: live room ----------
function renderDraft() {
  const D = S.draft, st = dstate();
  const me = st.teams[D.me];
  const myPlayers = me.players.map(id => byId.get(id)).filter(Boolean);
  const cur = D.current && !st.drafted.has(D.current) ? byId.get(D.current) : null;
  const options = st.board.slice(0, 400).map(p => `<option value="${esc(p.name)}">`).join('');
  const teamsNamed = D.teams.some(t => !/^Team \d+$/.test(t));
  let up = '';
  if (cur) {
    const ceiling = Math.min(Math.round(st.adjusted(cur)), me.maxBid);
    const rivals = st.teams.filter((t, i) => i !== D.me && t.maxBid >= ceiling).length;
    up = `<div class="card bidcard">
      <div class="row" style="justify-content:space-between"><b data-open="${esc(cur.id)}" style="font-size:18px">${esc(cur.name)}${pills(cur)}</b><button class="btn quiet" id="d-clear">Clear</button></div>
      <div class="label" style="margin-top:6px">Bid up to</div>
      <div class="bid">${money(ceiling)}</div>
      <div class="muted">Your price ${money(mine(cur))}${Math.abs(st.inflation - 1) >= 0.02 ? `, ${st.inflation > 1 ? 'up' : 'down'} ${Math.round(Math.abs(st.inflation - 1) * 100)}% for money left in the room` : ''} · ${rivals} team${rivals === 1 ? '' : 's'} can go higher${marketOf(cur) != null ? ` · Yahoo ~${money(marketOf(cur))}` : ''}</div>
      <div class="muted" style="margin-top:4px">${strengths(cur) || ''}</div>
      <div class="section-title" style="text-align:left">Who won him?</div>
      <div class="row"><select id="d-team" class="grow">${D.teams.map((t, i) => `<option value="${i}" ${i === D.me ? 'selected' : ''}>${esc(t)}${i === D.me ? ' (me)' : ''}</option>`).join('')}</select>
        <input id="d-price" style="width:84px" type="number" min="1" inputmode="numeric" placeholder="$"></div>
      <button class="btn block" id="d-sold" style="margin-top:8px">Record sale</button>
    </div>`;
  }
  const best = st.board.slice(0, 10);
  const dump = st.board.filter(p => ov(p.id).tag !== 'target' && (ov(p.id).tag === 'avoid' || (marketOf(p) ?? 0) >= st.adjusted(p) + 3))
    .sort((a, b) => (marketOf(b) ?? st.adjusted(b)) - (marketOf(a) ?? st.adjusted(a))).slice(0, 5);
  const tot = categoryTotals(myPlayers);
  $('#view').innerHTML = `
    <p class="intro">During the auction: type each <b>nominated player</b> to see your top bid, then record who won him and for how much.</p>
    ${!teamsNamed ? `<div class="notice"><span>Add the 14 team names first so budgets are tracked.</span><button id="d-setup">Set up</button></div>` : ''}
    <div class="statrow"><div><b>${money(me.left)}</b><span>my money</span></div><div><b>${money(me.maxBid)}</b><span>my max bid</span></div><div><b>${me.slots}</b><span>spots left</span></div></div>
    <div class="card" style="margin-top:12px"><label style="margin-top:0">Player up for bid</label><input id="d-search" list="d-names" placeholder="Start typing a name" autocomplete="off"><datalist id="d-names">${options}</datalist></div>
    ${up}
    <div class="section-title">Best left for you</div>
    <div class="list">${best.map(p => playerRow(p, { right: `<div class="price">${money(st.adjusted(p))}</div><div class="muted small">bid limit</div>` })).join('')}</div>
    ${dump.length ? `<div class="section-title">Nominate these</div><div class="muted" style="margin:0 2px 8px">Others will overpay; nominating them drains their budgets.</div><div class="list">${dump.map(p => playerRow(p, { right: `<div class="price down">~${money(marketOf(p) ?? st.adjusted(p))}</div><div class="muted small">room price</div>` })).join('')}</div>` : ''}
    <div class="section-title">My team · ${myPlayers.length}/${league.rosterSize}</div>
    <div class="card">${myPlayers.map(p => `<div class="item row" data-open="${esc(p.id)}"><span class="grow">${esc(p.name)} <span class="muted">${esc(p.pos.join('/'))}</span></span><b>${money(D.picks.find(k => k.playerId === p.id).price)}</b></div>`).join('') || '<div class="muted">Nobody yet.</div>'}
      ${myPlayers.length ? `<div class="section-title">Where my team stands</div>${catBars({ z: tot })}` : ''}</div>
    <div class="section-title">Teams</div>
    <div class="card"><table><tr><th>Team</th><th class="num">Money</th><th class="num">Spots</th><th class="num">Max bid</th></tr>
      ${st.teams.map((t, i) => `<tr class="${i === D.me ? 'me' : ''}" data-team="${i}"><td>${esc(D.teams[i])}</td><td class="num">${money(t.left)}</td><td class="num">${t.slots}</td><td class="num">${money(t.maxBid)}</td></tr>`).join('')}</table>
      <div class="muted" style="margin-top:6px">${money(st.money)} left in the room for ${st.slots} spots. Tap a team to see its roster.</div></div>
    <div class="section-title">Sales · ${D.picks.length}</div>
    <div class="card"><div class="row"><button class="btn secondary grow" id="d-undo" ${D.picks.length ? '' : 'disabled'}>Undo last sale</button><button class="btn secondary grow" id="d-csv" ${D.picks.length ? '' : 'disabled'}>Copy results</button></div>
      ${[...D.picks].reverse().slice(0, 30).map(k => `<div class="item">${esc(byId.get(k.playerId)?.name ?? k.playerId)} → ${esc(D.teams[k.team])} <b>${money(k.price)}</b></div>`).join('')}</div>`;
  const search = $('#d-search');
  search.onchange = () => { const p = st.board.find(x => normName(x.name) === normName(search.value)); if (p) { D.current = p.id; save(); render(); } };
  if ($('#d-setup')) $('#d-setup').onclick = openSettings;
  if (cur) {
    $('#d-clear').onclick = () => { D.current = null; save(); render(); };
    $('#d-sold').onclick = () => {
      const price = Math.round(+$('#d-price').value), team = +$('#d-team').value;
      if (!(price >= 1)) return toast('Enter the winning bid');
      if (price > st.teams[team].maxBid) return toast(`${D.teams[team]} can bid at most ${money(st.teams[team].maxBid)}`);
      D.picks.push({ playerId: cur.id, team, price, at: Date.now() });
      D.current = null; save(); render(); toast(`${cur.name} → ${D.teams[team]} ${money(price)}`);
    };
  }
  $('#d-undo').onclick = () => { D.picks.pop(); save(); render(); };
  $('#d-csv').onclick = () => copyText(['player,team,price', ...D.picks.map(k => `"${byId.get(k.playerId)?.name ?? k.playerId}","${D.teams[k.team]}",${k.price}`)].join('\n'), 'Results copied');
  document.querySelectorAll('[data-team]').forEach(r => r.onclick = () => {
    const i = +r.dataset.team, t = st.teams[i];
    sheet(`<div class="sheet-head"><div><h2>${esc(D.teams[i])}</h2><div class="muted">${money(t.left)} left · ${t.slots} spots · max bid ${money(t.maxBid)}</div></div><button class="close" data-close>✕</button></div>
      <div class="card" style="margin-top:12px">${t.players.map(id => { const p = byId.get(id); return `<div class="item row"><span class="grow">${esc(p?.name)} <span class="muted">${esc(p?.pos?.join('/'))}</span></span><b>${money(D.picks.find(k => k.playerId === id).price)}</b></div>`; }).join('') || '<div class="muted">Nobody yet.</div>'}</div>
      ${t.players.length ? `<div class="card">${catBars({ z: categoryTotals(t.players.map(id => byId.get(id)).filter(Boolean)) })}</div>` : ''}`);
  });
  bindOpen($('#view'));
}

// ---------- Settings (⚙): set-up jobs and the why, out of the way of the main journey ----------
function openSettings() {
  const D = S.draft;
  sheet(`<div class="sheet-head"><div><h2>Settings</h2><div class="muted">${esc(league.name)}</div></div><button class="close" data-close>✕</button></div>
    <div class="section-title">Draft night</div>
    <div class="card">
      <label style="margin-top:0">Team names, one per line</label>
      <textarea id="s-teams" rows="7">${esc(D.teams.join('\n'))}</textarea>
      <label>Which one is you?</label>
      <select id="s-me">${D.teams.map((t, i) => `<option value="${i}" ${i === D.me ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
      <div class="row" style="margin-top:10px"><button class="btn grow" id="s-save">Save teams</button><button class="btn danger" id="s-reset" ${D.picks.length ? '' : 'disabled'}>Clear sales</button></div>
    </div>
    <div class="section-title">Market prices</div>
    <div class="card">
      <div class="muted">Using Yahoo's average auction prices (${ranked.filter(p => p.yahoo).length} players). Paste your own "Name, $" lines to override them, e.g. from a mock draft.</div>
      <textarea id="s-market" placeholder="Nikola Jokic, 68" style="margin-top:8px"></textarea>
      <div class="row" style="margin-top:8px"><button class="btn secondary grow" id="s-market-go">Use these prices</button>${Object.keys(S.market).length ? `<button class="btn danger" id="s-market-clear">Clear ${Object.keys(S.market).length}</button>` : ''}</div>
    </div>
    <div class="section-title">Your data</div>
    <div class="card">
      <div class="muted">Your prices, tags and draft are saved on this phone only. Copy a backup to move them to another device.</div>
      <div class="row" style="margin-top:10px"><button class="btn secondary grow" id="s-export">Copy backup</button><button class="btn secondary grow" id="s-import">Restore</button></div>
    </div>
    <button class="btn secondary block" id="s-about" style="margin-top:4px">How the numbers work</button>
    <details class="more" style="margin-top:12px"><summary>Advanced: use your own projections</summary><div class="inner">
      <div class="muted">A CSV with per-game columns (Player, Team, Pos, G, MP, FG, FGA, 3P, FT, FTA, TRB, AST, STL, BLK, TOV, PTS). Replaces the built projections on this phone.</div>
      <textarea id="s-proj"></textarea>
      <div class="row" style="margin-top:8px"><button class="btn secondary grow" id="s-proj-go">Use these</button>${S.importedPlayers ? '<button class="btn danger" id="s-proj-clear">Back to built data</button>' : ''}</div>
    </div></details>`);
  $('#s-save').onclick = () => {
    const names = $('#s-teams').value.split('\n').map(s => s.trim()).filter(Boolean);
    if (names.length < 2) return toast('Enter the team names');
    D.teams = names; D.me = Math.min(+$('#s-me').value, names.length - 1); save(); render(); openSettings(); toast('Teams saved');
  };
  $('#s-me').onchange = e => { D.me = +e.target.value; save(); render(); };
  $('#s-reset').onclick = () => { if (confirm('Clear every recorded sale?')) { D.picks = []; D.current = null; save(); render(); openSettings(); } };
  $('#s-market-go').onclick = () => {
    let n = 0;
    for (const l of $('#s-market').value.split('\n')) { const m = /^(.+?)[,\t]\s*\$?(\d+(?:\.\d+)?)/.exec(l.trim()); if (m) { S.market[normName(m[1])] = +m[2]; n++; } }
    save(); render(); openSettings(); toast(`${n} prices loaded`);
  };
  if ($('#s-market-clear')) $('#s-market-clear').onclick = () => { S.market = {}; save(); render(); openSettings(); };
  $('#s-export').onclick = () => copyText(JSON.stringify(S), 'Backup copied');
  $('#s-import').onclick = () => { const j = prompt('Paste a backup'); if (!j) return; try { S = { ...blank(), ...JSON.parse(j) }; save(); recompute(); render(); toast('Restored'); closeSheet(); } catch { toast('That is not a backup'); } };
  $('#s-about').onclick = openAbout;
  $('#s-proj-go').onclick = () => {
    try { const ps = importProjections($('#s-proj').value); if (ps.length < 150) throw new Error(`Only ${ps.length} players with 12+ minutes`); S.importedPlayers = ps; save(); recompute(); render(); toast(`${ps.length} players loaded`); }
    catch (e) { toast(e.message); }
  };
  if ($('#s-proj-clear')) $('#s-proj-clear').onclick = () => { S.importedPlayers = null; save(); recompute(); render(); openSettings(); };
}

function openAbout() {
  const rows = (evalData?.summary ?? []).filter(s => s.spearman != null && /^(naive|model: stats|ESPN pre|blend: 75)/.test(s.label));
  const nice = { 'naive: last season as it happened': 'Last season repeated', 'model: stats only (Basketball Reference)': 'Stats model alone', 'ESPN preseason projection': 'ESPN alone', 'blend: 75% ESPN + 25% model': 'What this app uses' };
  const g = h2h.map(r => ({ season: r.season, z: r.results.find(x => /plain/.test(x.formula)), g: r.results.find(x => /G-scores/.test(x.formula)) }));
  sheet(`<div class="sheet-head"><div><h2>How the numbers work</h2><div class="muted">And how well they've done</div></div><button class="close" data-close>✕</button></div>
    <div class="card" style="margin-top:12px"><h2>1. Projections</h2>
      <div class="muted">Each player's season: 75% ESPN's projection, 25% a stats model of his last two seasons, with ESPN's habit of projecting about 1.3 minutes a game too many corrected. Teams, rookies and depth charts come from ESPN.</div>
      ${rows.length ? `<table style="margin-top:8px"><tr><th>Tested on four past seasons</th><th class="num">Ranking accuracy</th><th class="num">Avg $ miss</th></tr>${rows.map(r => `<tr><td>${esc(nice[r.label] ?? r.label)}</td><td class="num">${r.spearman.toFixed(2)}</td><td class="num">$${r.maeDollars.toFixed(2)}</td></tr>`).join('')}</table>` : ''}</div>
    <div class="card"><h2>2. Prices</h2>
      <div class="muted">Prices are built for weekly head-to-head: a category that swings a lot week to week counts a little less. The $2,800 in the room is shared out in proportion to how much better each player is than the best one left undrafted.</div>
      ${g.length ? `<table style="margin-top:8px"><tr><th>Weeks won, replaying past seasons</th>${g.map(x => `<th class="num">${x.season - 1}-${String(x.season).slice(2)}</th>`).join('')}</tr><tr><td>Head-to-head pricing</td>${g.map(x => `<td class="num">${Math.round((x.g?.matchupWinRate ?? 0) * 100)}%</td>`).join('')}</tr><tr><td>Season-total pricing</td>${g.map(() => '<td class="num">50%</td>').join('')}</tr></table>` : ''}</div>
    <div class="card"><h2>3. Yahoo prices</h2>
      <div class="muted">Yahoo's average auction prices come from mostly 10–12-team leagues, so each player's Yahoo rank is priced at what that rank costs in your 14-team league. Yahoo rooms overpay stars (top 10 go for ~1.18× Yahoo's own values) and underpay the middle (#31–100 for 0.3–0.65×).</div></div>
    <div class="card"><h2>4. News</h2>
      <div class="muted">Twice a day the app reads ESPN and FantasyPros news. An AI reader flags injuries and role changes (95% accurate on hand-checked notes) and Claude turns the ones that matter into the changes you see on the News tab. Nothing moves a price until you apply it. When you apply an absence, teammates get the share of his minutes measured from past seasons.</div></div>
    <div class="card"><h2>5. Uncertainty</h2>
      <div class="muted">In past seasons 8 in 10 drafted players finished within about −$11 / +$10 of their projected price. Treat a few dollars' difference as a tie.</div>
      ${qa?.problems?.length ? `<div class="down" style="margin-top:6px">Data problems on the last refresh: ${esc(qa.problems.join('; '))}</div>` : ''}</div>`);
}

// ---------- shell ----------
function sheet(html) {
  $('#sheetBody').innerHTML = `<div class="grabber"></div>${html}`;
  $('#sheet').hidden = false;
  document.body.style.overflow = 'hidden';
  $('#sheetBody').querySelectorAll('[data-close]').forEach(b => b.onclick = closeSheet);
}
function closeSheet() { $('#sheet').hidden = true; document.body.style.overflow = ''; }
function go(t) { tab = t; S.tab = t; save(); window.scrollTo(0, 0); render(); }
function render() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  const [title, eyebrow] = TITLES[tab];
  $('#title').textContent = title;
  $('#eyebrow').textContent = eyebrow;
  const pend = pendingProposals().length;
  $('#newsBadge').hidden = !pend; $('#newsBadge').textContent = pend;
  const top = boardOrder().slice(0, S.yahooCount ?? YAHOO_DEFAULT_COUNT);
  const todo = top.filter(p => yahooState(p) !== 'done').length;
  $('#yahooBadge').hidden = !todo || !S.yahooDone || !Object.keys(S.yahooDone).length;
  $('#yahooBadge').textContent = todo; $('#yahooBadge').className = 'badge soft';
  ({ prep: renderPrep, board: renderBoard, yahoo: renderYahoo, news: renderNews, draft: renderDraft })[tab]();
}

init();
