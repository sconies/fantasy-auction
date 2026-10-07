# Auction Board

A phone-first draft companion for **YUL to YYZ to SEA to SFO**: a 14-team Yahoo
head-to-head 9-category league with a $200 live auction (18–19 Oct 2026).

The app is organised around getting ready for the auction:

- **Prep**: days to the draft, a four-step checklist with progress, and what the Yahoo room is likely
  to get wrong (players to let others overpay for, bargains to target).
- **Board**: your price for every player, with what Yahoo drafters usually pay next to it (green is
  a bargain, red is pricey). Tap a player to move his price with − / +, tag him Target or Avoid, see
  why he's priced that way, and adjust his games or minutes.
- **Yahoo**: the list to copy into Yahoo's pre-draft values: Yahoo's default crossed out, your value
  beside it, biggest changes first. Tick each one off; a price that changes after you entered it comes
  back to re-enter.
- **News**: changes waiting for your OK, each with what it does to the price. Applying an absence
  also gives teammates their measured share of his minutes.
- **Draft**: on the night, type the nominated player to see your bid limit (adjusted for the money
  left in the room), then record the sale.
- **⚙ Settings**: team names, market prices, backup, and *How the numbers work*.

## How good are the values?

Setup → **Data & value quality** shows both tests; re-run them with `node scripts/backtest.mjs`
and `node scripts/simulate-h2h.mjs <season> --projected`.

- **Projections** (`scripts/backtest.mjs` → `data/eval.json`): each of 2022-23 to 2025-26 projected
  before it started, valued, and compared with what happened. Rank correlation: last season repeated
  0.54, stats model 0.60, ESPN preseason 0.68, **75% ESPN + 25% stats model 0.68 with the smallest
  dollar miss ($6.81)**. That blend is what the app uses.
- **Formula** (`scripts/simulate-h2h.mjs` → `data/eval-h2h-*.json`): one team drafts from preseason
  projections with each formula against 13 plain-z-score teams, then the real season's weekly stats
  are replayed head to head. **G-scores** (z-scores that count each category's week-to-week noise,
  `data/model/tau.json`) won 66%, 66% and 61% of weeks in 2025-26, 2024-25 and 2023-24; capping
  z-scores did nothing. G-scores are the default; plain z-scores are a switch in Setup.
- Limits: snake draft as a stand-in for the auction, no position limits, everyone on a roster plays.

## News pipeline (twice a day)

```
GitHub Actions, 1:30 pm and 11 pm Eastern (.github/workflows/data.yml)
  collect   ESPN projections, depth charts, injuries, headlines; FantasyPros consensus and player news
  Jev       reads every new text: absence length (tested 95% on hand labels) and 29 flags (96.5%)
  build     projections, ESPN bias corrections, depth moves and big projection moves
  signals   data/signals.json: what may need a judgement
Claude routine, 2:15 pm and 11:45 pm Eastern (jobs/routine.md, jobs/news.md)
  sizes the flagged items into proposals in data/adjustments.json, or skips them with a reason
You, in the app's News tab
  accept or reject; an accepted absence also gives its minutes to teammates
```

What the tests found (Setup → Data & value quality has the numbers):

- **Jev's flags on preseason news don't beat ESPN.** 2,274 archived Rotowire preseason notes
  (2022-23 to 2025-26, Wayback Machine) flagged by Jev, fitted against ESPN's projection misses one
  season held out at a time (`scripts/fit-flags.mjs`). Per-36 rates: nothing above noise. Games: the
  fit found effects pointing the wrong way (a minutes limit "adding" games), a healthy-player proxy, so
  a direction check rejects them. ESPN already prices preseason news in. Jev's job is therefore to
  **read news fast and route it** (absences, role changes) to proposals, not to move numbers itself.
- **Kept: ESPN's average misses.** ESPN projects ~1.3 minutes a game too many and assists per 36
  slightly low, every season; corrected in the build.
- **Teammates gain when a starter sits** (`scripts/fit-cascade.mjs`, three seasons of weekly logs): each
  same-position teammate picks up ~10-15% of his minutes, others ~7%, with a small scoring-rate rise.
- **Playoff weeks 18-20** (mid-Feb to 21 Mar): players 32+ play 4-8% fewer games than before, under-25s
  3-5% more; a small availability factor.
- **Uncertainty:** 8 in 10 drafted players finish within about -$11/+$10 of their projected value; flag
  tiers didn't change that, so the app shows one range.

## How values are made (`lib/value.mjs`)

1. **Projections** (`scripts/build-players.mjs`): the last two seasons'
   per-game stats from Basketball Reference, weighted by games played (the
   older season at half weight), with a small age nudge. Projected games =
   recent games regressed toward 70, capped at 78.
2. **Category scores**: a per-game z-score in each category, measured against
   the 182 players who will actually be drafted (14 teams × 13 roster spots).
   FG% and FT% count by impact (makes above an average shooter on the same
   attempts), so volume matters. Turnovers count against a player.
3. **Availability**: value per game above a replacement player × share of the
   season played. With a 2-adds-a-week cap you can't stream around injuries,
   so missed games cost real value.
4. **Dollars**: $2,800 in the room, minus $1 for each of the 182 spots, leaves
   $2,618. That is split in proportion to value above replacement, so the
   182nd player is worth $1.
5. **Live inflation**: (money left − $1 × open spots) ÷ (value above $1 of the
   best players still available). If early overpays leave less money for the
   same talent, everyone left gets cheaper, and the reverse.

## Data

`.github/workflows/data.yml` runs every six hours on GitHub: it fetches stats
(daily), rebuilds projections, fetches ESPN injuries and headlines, runs the
tests and commits `data/`. Start it once by hand from the Actions tab.

- `data/positions.json`: `{ "<bbref id>": ["PG","SG"] }` to match Yahoo's
  position eligibility where it differs from Basketball Reference.
- `data/extra-players.json`: rookies and anyone without NBA stats, written as
  per-game projections.
- `data/adjustments.json`: proposals from the news job (append only).

Your ranks and draft are stored in the browser (`localStorage`). Use
Setup → Backup to move them between devices.

## Run locally

```
python3 -m http.server   # then open http://localhost:8000
node --test tests/*.test.mjs
```

It deploys as a static site: import the repo in Vercel, with no build command.
