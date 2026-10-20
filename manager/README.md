# Team manager: Yahoo league 81341

How Claude runs Lane's in-season team, "Shawn Kemp is my Dad". The league is 12 teams, H2H with 9 categories
(FG%, FT%, 3PTM, PTS, REB, AST, ST, BLK, TO), daily lineups and 2 adds a week.
Lane asked on 20 Oct 2026: "I want you to fully manage my team".

## What wins this format

1. **Games played.** Lineups are set daily. A healthy player with a game sitting on the bench, or an empty
   slot, is stats thrown away. This is the biggest lever and the cheapest to pull.
2. **IL slots.** Moving an Out player to IL frees a roster spot for a free agent at no cost.
3. **Two adds a week, used every week.** Prefer players who keep value. When a matchup is close, stream
   players whose teams play 4 games and who fill the categories that can still swing.
4. **Category targeting.** Each week, push the categories in the 20-80% band against this opponent. Don't
   chase the ones that are already won or already lost.
5. **Trades.** Trades are for rest-of-season gains only. Each trade must look fair by name value, or the
   other manager won't accept it.

## Cadence

| When (London) | What runs | What Claude does on its own | What needs Lane |
|---|---|---|---|
| Daily 22:41, before the first 7pm ET tip | **Daily run.** The Mac reads Lane's roster, the matchup, injuries, free agents and the schedule. The engine plans. | Moves Out players to IL. Sets today's and tomorrow's lineups (tomorrow's covers weekend matinees). Brings healthy players back from IL. Makes a mid-week streaming add when the engine finds a gain and adds remain. | Nothing, unless a move needs a protected player dropped |
| Sunday 09:47 | **Weekly run.** Reads all 12 rosters, the next opponent, the top 60 free agents and waiver players, and 14 days of schedule. | Plans the week's 2 adds and puts in waiver claims. Sets Monday's lineup. Writes the report to `/mnt/project-files/fantasy/weekly/<date>.md`. | One batched line, only if there's a trade worth offering or a protected drop |
| Any run that sees one | **Incoming trade offer** | Scores the offer with the engine | Accept or decline, with a recommendation |

Every move made is logged in `/mnt/project-files/fantasy/moves.md`.

## What Claude may do, and what it asks for

- **Claude does these itself:** lineups, IL moves, adds and drops of unprotected players within the 2-a-week
  cap, and waiver claims.
- **Claude asks Lane first:**
  - dropping or trading a protected player (drafted for $10+; the list is in `config.json`);
  - sending or accepting any trade, since a trade involves another manager;
  - anything touching league settings, which belong to Nick, the commissioner.
- **Claude never does these:** message other managers, open the Pre-Draft Values page, or pay for anything.
- **The Mac's safety check** wants Lane's own words for changes. Each run starts its Mac session from Lane's
  "fully manage" message (`cmsg_01JrrZMiTZiguC8Rqq3JEfMdYJJEmST8fndyorJE7QqhXH`). If the check still blocks
  a move, Claude posts the moves in one line in the thread. Lane's reply ("ok") reaches the Mac directly
  and the move goes through.
- **Quiet hours:** no thread replies 09:00-18:00 London on weekdays unless a lineup locks that day.

## The engine (`manager/`)

`node manager/plan.mjs <snapshot.json> --mode daily|weekly [--today YYYY-MM-DD] [--out dir]` prints a report
and writes `plan.json`. It runs in the cloud, and it is free.

- **Projections** come from `data/players.json` (ESPN blended with the model), with injury tags refreshed on
  `main`.
- **Daily lineup** is the best set of starters for the day's slots. Slots form a transversal matroid, so
  taking players in value order with augmenting paths is optimal. This catches cases Yahoo's
  "Start Active Players" misses.
- **Matchup odds** come from summing each side's starters over the remaining days, expected stats times
  availability (O = 0, GTD = 0.6, else 0.95):
  - Each category's variance comes from `data/model/tau.json`, the measured week-to-week noise.
  - The P(win) for each category is a normal approximation; FG% and FT% use makes over attempts.
  - P(win the week) treats categories as independent and counts 5+ of 9.
  - Stats already banked this week are added via `matchupSoFar`.
- **Pickups:** every free agent is tried against every unprotected player.
  - The score is the gain in expected categories this week, plus 2 × the gain in a typical week against the
    league-average team.
  - The best pair is taken first, then the next, up to the adds left. A move must score at least 0.15
    expected categories.
- **Trades:** every 1-for-1 and 2-for-2 deal with each team is scored for both sides on a typical week.
  - A deal must gain us 0.1+ categories a week and not hurt them by our model.
  - What they get must also be worth at least 85% of what they give, by market value.
  - The report shows the best deal per team, top three.
- **Tests:** `npm test`, in `tests/manager.test.mjs`.

## Snapshot the Mac sends back (JSON)

```json
{
  "leagueDate": "2026-10-26",
  "myTeam": "Shawn Kemp is my Dad",
  "opponent": "Mike S",
  "rosterSize": 13,
  "slots": ["PG","SG","G","SF","PF","F","C","C","Util","Util","BN","BN","BN","IL","IL"],
  "week": { "start": "2026-10-26", "end": "2026-11-01", "addsUsed": 0, "addsMax": 2 },
  "pendingClaims": [{ "add": "Brook Lopez", "drop": null, "clears": "2026-10-22" }],
  "teams": { "Shawn Kemp is my Dad": [{ "name": "Nikola Jokic", "nba": "DEN", "pos": "C", "status": "", "slot": "C" }] },
  "freeAgents": [{ "name": "Nikola Vucevic", "nba": "ORL", "pos": "C", "status": "", "waiver": false, "pctRostered": 61 }],
  "schedule": { "2026-10-26": ["DEN", "LAL"] },
  "matchupSoFar": { "me": { "fgm": 0, "fga": 0, "ftm": 0, "fta": 0, "tpm": 0, "pts": 0, "reb": 0, "ast": 0, "stl": 0, "blk": 0, "tov": 0 }, "opp": {} },
  "tradeOffers": []
}
```

- **Daily runs** need only Lane's team and the opponent in `teams`. **Weekly runs** need all 12.
- **Dates** are US dates.
- **The schedule** comes from `https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json` on the Mac,
  read as `leagueSchedule.gameDates[].games[].{homeTeam,awayTeam}.teamTricode`. It covers today plus 13 days.

## Known limits and next steps

- **Stale projections.** They are preseason projections. After about 3 weeks they should blend in this
  season's per-game stats. `scripts/fetch-weekly.mjs` already pulls ESPN game logs; wire it into
  `players.json` before mid-November.
- **The Mac must be awake.** A missed daily run costs one day. Claude tells Lane only after two misses in a
  row.
- **No minutes or role changes.** The engine doesn't model these. News-driven pickups (a starter's injury
  opening a role) rely on Yahoo's top-60 free agent list catching them.
