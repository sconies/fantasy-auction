# Auction Board

A phone-first draft companion for **YUL to YYZ to SEA to SFO**: a 14-team Yahoo
head-to-head 9-category league with a $200 live auction (18–19 Oct 2026).

- **Ranks**: every player's auction value from projections, plus your own
  ±$ adjustment, Target/Avoid tags, games and minutes edits, and notes. Tap a
  category to punt it and every value is recalculated.
- **News**: injuries and headlines. Injuries with a return date become
  proposed "games missed" changes. A Claude job (`jobs/news.md`) proposes role
  and minutes changes. You accept or reject each one, and values recalculate.
- **Draft**: type the nominated player and the app gives you a bid ceiling
  (your value × live inflation, capped at your max bid), shows how many teams
  can outbid you, and how well the player fits your categories. Log each sale
  in two taps. It also tracks every team's money, open spots and max bid, the
  best players left, and players worth nominating to drain budgets.
- **Setup**: team names, market prices (paste Yahoo's average cost), pasted
  projections, and backup/restore.

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
