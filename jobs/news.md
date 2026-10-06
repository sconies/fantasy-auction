# News job: turn NBA news into proposed projection changes

Run by Claude (scheduled or on request). The output is **proposals**. The owner
accepts or rejects each one in the app's News tab, and nothing changes a value
until they do.

## Rule: change the inputs, never the dollars

A proposal says what the news changes about a player's season: games played,
minutes, or a single stat. The app turns that into dollars itself. Never write
a dollar figure or a rank.

## Steps

1. Read `data/news.json`: injuries and headlines, refreshed every six hours by
   the GitHub Action. Search for anything newer if you can: the team's beat
   reporters, Rotowire, Underdog NBA.
2. Look up player ids with
   `node -e "const p=require('./data/players.json').players; console.log(p.filter(x=>/NAME/i.test(x.name)).map(x=>[x.id,x.name,x.team,x.projG,x.min.toFixed(1)]))"`.
   Don't open the whole file.
3. The app already proposes games missed for every injury that has an ESPN
   return date. Only add what it can't see:
   - an injury with no return date but a reported timeline ("6-8 weeks")
   - a role change: a trade, a new starter, a minutes cap lifted or imposed, a
     coach's quote
   - a suspension
4. Append to `data/adjustments.json` → `adjustments`. Never edit or remove
   existing entries; a new entry supersedes the old one in the reason text.
   ```json
   { "id": "2026-10-07-wembanyama-minutes", "playerId": "wembavi01", "name": "Victor Wembanyama",
     "date": "2026-10-07", "minutesMult": 1.06,
     "reason": "Minutes restriction lifted after camp; was 30 mpg last spring, expected 33",
     "source": "https://..." }
   ```
   Fields: one or more of `games` (absolute), `gamesDelta`, `minutesMult`,
   `minutes` (absolute mpg), `statMult` (for example `{"tpm": 1.15}`).
   `reason` must say what was reported and how you got the number.
5. Validate with `node --test tests/*.test.mjs`, then commit
   "News: <players>" to `main`.

## How to size the numbers

- Games missed: about 82 × (days out during the season) ÷ 173. The season runs
  20 Oct 2026 to 11 Apr 2027 (`data/league.json`).
- A move from bench to starter is usually +5 to +8 minutes; express it as
  `minutes`.
- When the reporting is vague, propose the middle of the range and say so.
