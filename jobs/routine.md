# The news routine

Create it once in **claude.ai → Code → Routines → New routine**. Don't create it from a session's
tools: a routine made that way stores no repository, and its sessions start without the checkout
(learned on the house tracker, 29 Sep and 4 Oct 2026).

- **Repository:** `sconies/fantasy-auction`, branch `main`
- **Environment:** the default is fine. The job only reads and writes the repository; all fetching
  happens in GitHub Actions.
- **Schedule:** daily at **2:15 pm** and **11:45 pm** Eastern. That's 45 minutes after the GitHub
  data job, which can start up to ~15 minutes late.
- **Session:** a new session each run
- **Model:** Sonnet
- **Permissions:** no approval prompts (nobody is there to approve)
- **Connectors:** none
- **Notifications:** on, if you want a ping when proposals are waiting

## Prompt

```
Scheduled news run for the fantasy auction app. This is a fresh session: the repository is the only memory.

FIRST run: git fetch origin main && git checkout -B main origin/main && git reset --hard origin/main && git log --oneline -1

Then read jobs/news.md once and carry out its steps 1 to 7 in order. Nobody is watching: never ask a question or wait for confirmation. If there is nothing to judge, record the run (step 6), commit and push, and finish quickly. Never edit dollar values, data/players.json or the app code. If a step cannot run, record why in data/news-run.json's note. End with one line: the proposals made and the commit pushed, or "nothing new".
```

## Checking it

Every run commits `News: …` to `main`, quiet runs included, and the app's News tab shows the last
run's time and result. No such commit for a day means the routine isn't running: open its latest
session from the Routines page to see where it stopped.
