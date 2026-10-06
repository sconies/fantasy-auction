# News job: size what Jev flagged into proposals

Run by a Claude routine twice a day (`jobs/routine.md`), about 45 minutes after the GitHub data job
(1:30 pm and 11 pm Eastern). Each run is a fresh session: the repository is the only memory.

The output is **proposals** in `data/adjustments.json`. The owner accepts or rejects each one in the
app's News tab, and nothing changes a value until they do.

## Rules
- **Change inputs, never dollars.** A proposal moves games, minutes or a stat rate; the app values it.
- **One proposal per real change.** Never more than two for a player in a run.
- **Cite the text.** `reason` says what was reported, by whom when the note names them, and how you got
  the number.
- **Don't duplicate what's automatic:**
  - injury absences already get a proposal from ESPN's date and Jev's reading;
  - teammates' extra minutes follow automatically when an absence is accepted (measured shares,
    `data/model/cascade.json`);
  - ESPN's projection already prices in preseason news (tested: Jev's flags don't improve on it), so
    a note that only restates what his projection shows needs no proposal.

  Mark such signals handled with a note saying which.
- Write JSON back as `JSON.stringify(data, null, 1) + '\n'`, the format the files already use, so a
  commit shows only what changed.
- Read files with `node -e` for the fields you need. Never open `data/players.json`,
  `data/jev/flag-cache.json` or `data/sources/*` whole.

## Steps
1. `git fetch origin main && git checkout -B main origin/main && git reset --hard origin/main`
2. List the signals to judge:
   ```
   node -e "const s=require('./data/signals.json').signals.filter(x=>x.status==='new'&&x.judge);console.log(s.length);for(const x of s)console.log(JSON.stringify({id:x.id,name:x.name,team:x.team,kind:x.kind,date:x.date,summary:x.summary,flags:x.flags,text:x.text}))"
   ```
   If there are none, go to step 6.
3. For each signal, get the player's current projection and role:
   ```
   node -e "const p=require('./data/players.json').players.find(x=>x.id==='ID');console.log(JSON.stringify({name:p.name,team:p.team,pos:p.pos,min:p.min,projG:p.projG,pts:p.pts,depth:p.depth,sources:p.sources,flagEffect:p.flagEffect,jevFlags:p.jevFlags}))"
   ```
   Check his team's depth chart where the role matters: `data/depth.json` lists every player's slot.
4. Decide, using these sizes unless the text says something more specific:

   | What the text says | Proposal |
   |---|---|
   | Named starter, was a bench player (depth #2+, under 26 min) | `minutes`: current + 5 to 8 |
   | Moved to the bench, was a starter | `minutes`: current − 5 to 8 |
   | Minutes restriction "for now" / "early in the season" | `minutes`: the cap if stated, else current − 6; say it is temporary |
   | Out of the rotation | `minutes`: 10 or less |
   | Traded or signed elsewhere | `minutes` for his slot on the new team's depth chart: starter ~30, #2 ~22, #3 ~15 |
   | Bigger offensive load, coach quote ("more shots", "the offense runs through him") | `statMult` up to `{"pts":1.08,"fga":1.08,"ast":1.05}` |
   | Season over, or a timeline the injury proposal doesn't have | `games` (absolute) or `gamesDelta` |
   | Rest on back-to-backs | `gamesDelta`: −8 (about half of a team's ~15 back-to-backs) |

   Skip a signal when the text is preseason-only (one exhibition game), a rumour, or already reflected
   in his projection (compare `min` and `sources`).
5. Append each proposal to `data/adjustments.json` → `adjustments`:
   ```json
   { "id": "2026-10-19-ivey-starter", "playerId": "4433218", "name": "Jaden Ivey", "date": "2026-10-19",
     "minutes": 31, "reason": "Named the starting PG by J.B. Bickerstaff (Detroit Free Press). Was 25 mpg off the bench; +6 for a starter's role.",
     "source": "https://...", "signalId": "text:abc123" }
   ```
   Then set that signal's `status` to `"handled"` and `handledNote` to a few words (the proposal id, or
   why it was skipped) in `data/signals.json`. Do the same for every signal you skip.
6. Record the run: write `data/news-run.json` as
   `{ "ranAt": "<ISO time>", "judged": N, "proposed": N, "skipped": N, "note": "<one line>" }`.
7. `node --test tests/*.test.mjs`, then commit "News: <players or 'nothing new'>" and push to `main`.
   If the push is rejected, `git pull --rebase origin main` and push again. Never force-push.
