// Turn a Yahoo snapshot into a plan: IL moves, lineups, pickups and trade ideas.
// node manager/plan.mjs <snapshot.json> [--mode daily|weekly] [--today YYYY-MM-DD] [--out dir]
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { CATS, LABEL, loadProjections, enrich, bestLineup, projectRange, matchup, dateRange, normName, isOut, gameVar } from './model.mjs';

const CONFIG = JSON.parse(readFileSync(new URL('./config.json', import.meta.url)));
const COUNT = ['fgm', 'fga', 'ftm', 'fta', 'tpm', 'pts', 'reb', 'ast', 'stl', 'blk', 'tov'];
const STANDARD_GAMES = 3.5; // a typical week, for rest-of-season value

export function plan(snap, { mode = 'weekly', today = snap.leagueDate } = {}) {
  const lookup = loadProjections(snap.projections ?? 'data/players.json');
  const teams = Object.fromEntries(Object.entries(snap.teams).map(([t, rows]) => [t, enrich(rows, lookup)]));
  const me = snap.myTeam ?? CONFIG.myTeam;
  const mine = teams[me];
  if (!mine) throw new Error(`My team "${me}" is not in the snapshot`);
  const slots = snap.slots;
  const protectedSet = new Set(CONFIG.protected.map(normName));
  const fas = enrich(snap.freeAgents ?? [], lookup).filter(p => p.avail > 0);
  const out = { mode, today, notes: [], il: [], lineups: [], moves: [], trades: [], offers: [], matchup: null };

  const unknown = [...mine, ...fas].filter(p => !p.known).map(p => p.name);
  if (unknown.length) out.notes.push(`No projection for ${unknown.join(', ')}; used a replacement-level line.`);

  // IL: park anyone ruled out, bring back anyone healthy. Activating with a full roster needs a drop.
  const ilSlots = slots.filter(s => s === 'IL').length;
  const onIl = mine.filter(p => p.slot === 'IL');
  let freeIl = ilSlots - onIl.length;
  for (const p of mine.filter(p => p.slot !== 'IL' && isOut(p.status))) {
    if (freeIl > 0) { out.il.push({ action: 'to IL', player: p.name, why: p.status }); freeIl--; }
    else out.notes.push(`${p.name} is ${p.status} but both IL slots are full.`);
  }
  for (const p of onIl.filter(p => !isOut(p.status))) out.il.push({ action: 'activate', player: p.name, why: 'healthy again', needsDrop: rosterCount(mine) >= snap.rosterSize });
  const roster = mine.map(p => out.il.some(m => m.player === p.name && m.action === 'to IL') ? { ...p, slot: 'IL' } : p);

  // Lineups for today and tomorrow.
  for (const d of dateRange(today, addDays(today, 1))) {
    const playing = new Set(snap.schedule?.[d] ?? []);
    const avail = roster.filter(p => p.slot !== 'IL' && playing.has(p.nba) && p.avail > 0);
    const lineup = bestLineup(avail, slots);
    const starters = new Set(lineup.filter(s => s.player).map(s => s.player.name));
    out.lineups.push({ date: d, start: lineup.map(s => ({ slot: s.slot, player: s.player?.name ?? null })),
      benchWithGame: avail.filter(p => !starters.has(p.name)).map(p => p.name) });
  }

  // This week's matchup over the days left (today through Sunday).
  const weekEnd = snap.week?.end ?? addDays(today, 6);
  const days = dateRange(mode === 'weekly' ? (snap.week?.start ?? today) : today, weekEnd);
  const opp = snap.opponent && teams[snap.opponent];
  const vsOpp = r => matchup(projectRange(r, days, snap.schedule, slots), projectRange(opp, days, snap.schedule, slots),
    snap.matchupSoFar?.me, snap.matchupSoFar?.opp);
  if (opp) {
    const m = vsOpp(roster);
    out.matchup = { opponent: snap.opponent, days: days.length, expCats: +m.expCats.toFixed(2), winProb: +m.winProb.toFixed(2),
      byCat: Object.fromEntries(CATS.map(c => [LABEL[c], +m.p[c].toFixed(2)])),
      swing: CATS.filter(c => m.p[c] > 0.2 && m.p[c] < 0.8).map(c => LABEL[c]) };
  }

  // Rest-of-season yardstick: a typical week against the league's average team.
  const others = Object.entries(teams).filter(([t]) => t !== me).map(([, r]) => standardWeek(r));
  const avgTeam = average(others);
  const ros = r => matchup(standardWeek(r), avgTeam).expCats;

  // Pickups: best add/drop pairs, one at a time, within the adds left this week.
  const addsLeft = (snap.week?.addsMax ?? CONFIG.maxAddsPerWeek) - (snap.week?.addsUsed ?? 0) - (snap.pendingClaims?.length ?? 0);
  let cur = roster;
  for (let n = 0; n < addsLeft; n++) {
    const base = { week: opp ? vsOpp(cur).expCats : 0, ros: ros(cur) };
    let best = null;
    const drops = cur.filter(p => p.slot !== 'IL' && !protectedSet.has(normName(p.name)));
    for (const fa of fas) {
      if (out.moves.some(m => m.add === fa.name)) continue;
      for (const d of drops) {
        const next = cur.map(p => p === d ? { ...fa, slot: 'BN' } : p);
        const dWeek = opp ? vsOpp(next).expCats - base.week : 0;
        const dRos = ros(next) - base.ros;
        // A keeper must not lose rest-of-season value; the weekly gain decides between keepers.
        const score = dWeek * (mode === 'weekly' ? 1 : 1.5) + CONFIG.rosWeight * dRos;
        if (!best || score > best.score) best = { add: fa.name, drop: d.name, waiver: !!fa.waiver, score, dWeek, dRos, nba: fa.nba };
      }
    }
    if (!best || best.score < CONFIG.minGain) break;
    out.moves.push(round(best));
    cur = cur.map(p => p.name === best.drop ? { ...fas.find(f => f.name === best.add), slot: 'BN' } : p);
  }

  // Trade ideas (weekly only): 1-for-1 and 2-for-2 swaps that help us and don't hurt them.
  if (mode === 'weekly') out.trades = tradeIdeas(teams, me, cur, ros, avgTeam, protectedSet);

  // Offers other managers have sent us: score them the same way.
  out.offers = (snap.tradeOffers ?? []).map(o => {
    const give = new Set(o.give.map(normName));
    const get = enrich(o.get.map(name => teams[o.from]?.find(p => normName(p.name) === normName(name)) ?? { name }), lookup);
    const next = roster.filter(p => !give.has(normName(p.name))).concat(get.map(p => ({ ...p, slot: 'BN' })));
    const dUs = +(ros(next) - ros(roster)).toFixed(2);
    return { ...o, dUs, verdict: dUs >= 0.1 ? 'accept' : dUs > -0.05 ? 'close call' : 'decline' };
  });
  return out;
}

function standardWeek(roster) {
  const mean = Object.fromEntries(COUNT.map(k => [k, 0]));
  const vari = Object.fromEntries(CATS.map(c => [c, 0]));
  for (const p of roster) {
    if (p.slot === 'IL' || p.avail === 0) continue;
    const g = STANDARD_GAMES * p.avail;
    for (const k of COUNT) mean[k] += g * p.line[k];
    for (const c of CATS) vari[c] += g * gameVar(c, p.line);
  }
  return { mean, vari };
}

function average(list) {
  const mean = Object.fromEntries(COUNT.map(k => [k, list.reduce((s, t) => s + t.mean[k], 0) / list.length]));
  const vari = Object.fromEntries(CATS.map(c => [c, list.reduce((s, t) => s + t.vari[c], 0) / list.length]));
  return { mean, vari };
}

function tradeIdeas(teams, me, mine, ros, avgTeam, protectedSet) {
  const ideas = [];
  const base = ros(mine);
  const tradeable = mine.filter(p => p.slot !== 'IL');
  const pairs = arr => arr.flatMap((a, i) => arr.slice(i + 1).map(b => [a, b]));
  for (const [team, theirs] of Object.entries(teams)) {
    if (team === me) continue;
    const theirBase = ros(theirs);
    const them = theirs.filter(p => p.slot !== 'IL');
    const offers = [...tradeable.flatMap(a => them.map(b => [[a], [b]])), ...pairs(tradeable).flatMap(a => pairs(them).map(b => [a, b]))];
    for (const [give, get] of offers) {
      const usNext = mine.filter(p => !give.includes(p)).concat(get);
      const themNext = theirs.filter(p => !get.includes(p)).concat(give);
      const dUs = ros(usNext) - base, dThem = ros(themNext) - theirBase;
      if (dUs < 0.1 || dThem < -0.02) continue;
      // Managers judge by name value too: what they get should look worth at least 85% of what they give.
      if (sum(give, 'market') < 0.85 * sum(get, 'market')) continue;
      ideas.push({ team, give: give.map(p => p.name), get: get.map(p => p.name), dUs: +dUs.toFixed(2), dThem: +dThem.toFixed(2),
        givesStar: give.some(p => protectedSet.has(normName(p.name))) });
    }
  }
  // Best deal per team, then the top three teams.
  const best = new Map();
  for (const t of ideas.sort((a, b) => b.dUs - a.dUs)) if (!best.has(t.team)) best.set(t.team, t);
  return [...best.values()].slice(0, 3);
}

const sum = (list, k) => list.reduce((s, p) => s + (p[k] ?? 0), 0);
const rosterCount = r => r.filter(p => p.slot !== 'IL').length;
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const round = m => ({ ...m, score: +m.score.toFixed(2), dWeek: +m.dWeek.toFixed(2), dRos: +m.dRos.toFixed(2) });

export function report(p) {
  const L = [`# Fantasy plan, ${p.mode}, ${p.today}`, ''];
  if (p.matchup) {
    const m = p.matchup;
    L.push(`**Matchup vs ${m.opponent}** (${m.days} days left): win chance ${Math.round(m.winProb * 100)}%, expected ${m.expCats} of 9 categories.`);
    L.push('', '| ' + Object.keys(m.byCat).join(' | ') + ' |', '|' + Object.keys(m.byCat).map(() => '---').join('|') + '|',
      '| ' + Object.values(m.byCat).map(v => Math.round(v * 100) + '%').join(' | ') + ' |', '');
    if (m.swing.length) L.push(`Swing categories: ${m.swing.join(', ')}.`, '');
  }
  if (p.il.length) L.push('**IL**', ...p.il.map(m => `- ${m.action}: ${m.player} (${m.why})${m.needsDrop ? ', needs a drop' : ''}`), '');
  if (p.moves.length) L.push('**Pickups**', ...p.moves.map(m => `- Add ${m.add}${m.waiver ? ' (waiver claim)' : ''}, drop ${m.drop}: +${m.dWeek} cats this week, ${m.dRos >= 0 ? '+' : ''}${m.dRos} per typical week after`), '');
  else L.push('**Pickups**: none worth an add right now.', '');
  for (const l of p.lineups) {
    L.push(`**Lineup ${l.date}**: ` + l.start.map(s => `${s.slot} ${s.player ?? '(empty)'}`).join(', '));
    if (l.benchWithGame.length) L.push(`  Bench with a game: ${l.benchWithGame.join(', ')}`);
  }
  if (p.offers?.length) L.push('', '**Trade offers received**', ...p.offers.map(o => `- From ${o.from}: they get ${o.give.join(' + ')}, we get ${o.get.join(' + ')}: ${o.dUs >= 0 ? '+' : ''}${o.dUs} cats/week, ${o.verdict}`));
  if (p.trades.length) L.push('', '**Trade ideas** (need Lane\'s yes before sending)', ...p.trades.map(t => `- With ${t.team}: give ${t.give.join(' + ')}, get ${t.get.join(' + ')} (us +${t.dUs}, them ${t.dThem >= 0 ? '+' : ''}${t.dThem} cats/week)`));
  if (p.notes.length) L.push('', '**Notes**', ...p.notes.map(n => `- ${n}`));
  return L.join('\n') + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = k => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
  const snap = JSON.parse(readFileSync(args[0], 'utf8'));
  const result = plan(snap, { mode: opt('mode') ?? 'weekly', today: opt('today') ?? snap.leagueDate });
  const dir = opt('out');
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/plan.json`, JSON.stringify(result, null, 1));
    writeFileSync(`${dir}/plan.md`, report(result));
  }
  process.stdout.write(report(result));
}
