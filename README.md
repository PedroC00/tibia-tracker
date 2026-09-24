# Tibia Tracker

A personal, non-commercial fan project. Once a day it sends a Pushover notification (iPhone + Mac) with:

- 🏠 **House auctions on one world**: new auctions, plus houses whose bid went up.
- ⚔️ **New Char Bazaar auctions** matching skill filters.

The first successful run sends one summary ("Tracking started…"). After that you only hear about new auctions.

**Need to reach me?** [Open an issue](../../issues/new). The tracker stops itself right away (see [Kill switch](#kill-switch)).

## Data sources

| What | Source | Notes |
|---|---|---|
| Houses | [TibiaData API v4](https://api.tibiadata.com) `/v4/houses/{world}/{town}` | Open-source community API, cached behind Cloudflare |
| Char Bazaar | tibia.com, parsed with [tibia.py](https://github.com/Galarzaa90/tibia.py) | No open API serves current auctions ([TibiaData PR #715](https://github.com/tibiadata/tibiadata-api-go/pull/715) is not merged yet). Requests are filtered server-side, spaced 3 s apart, capped per run, and only happen once a day. The User-Agent links to this repo. |

### Current status: characters off, houses on

tibia.com answers **403** to GitHub's servers (cloud/datacenter IPs are blocked in general), so the kill switch stopped the bazaar check on its first request, as intended. The bazaar is now disabled in the config (`bazaar.enabled: false`). Houses keep running.

Each run makes one cached request to see whether TibiaData serves the bazaar yet ([PR #715](https://github.com/tibiadata/tibiadata-api-go/pull/715), `/v4/charactertrades/ending`, currently 404). When it goes live you get one push, and the bazaar check can be switched over to TibiaData.

## Kill switch

The tracker stops itself and stays stopped until the owner resumes it. Every stop sends a **high-priority** push.

| Trigger | What stops | Automatic action |
|---|---|---|
| tibia.com serves a Cloudflare challenge, or answers 401/403/429 | Bazaar checks | No retry, no further requests |
| TibiaData answers with a challenge or 401/403/429 | House checks | No retry, no further requests |
| Anyone other than the owner opens an issue on this repo | **Everything** | Posts [.github/AUTO_REPLY.md](.github/AUTO_REPLY.md) on the issue (once) |

A stop is recorded in `state/halt.json`. **To resume:** reply to and close any open issues, then delete `state/halt.json` (in the GitHub web UI, or commit the deletion). While an outside issue is still open, the next run halts again, but it won't post a second reply.

Server errors (5xx) and parse failures don't halt anything. They count as failures, and you get a warning after 2 in a row.

## Privacy

The code is public; what I track is not.

| Item | Where it lives | Public? |
|---|---|---|
| Real filters (world, towns, skill thresholds) | `TRACKER_CONFIG` secret, plus `config.local.yaml` locally (git-ignored) | No |
| [config.yaml](config.yaml) | Repo | Yes, but only placeholder example values |
| Matched auctions / houses | `state/seen.json.enc`, encrypted with the `STATE_KEY` secret | Encrypted only |
| Actions logs | GitHub | Yes, so they show only counts, never filters, worlds or URLs |
| Pushover keys | `PUSHOVER_TOKEN` / `PUSHOVER_USER` secrets | No |

Each top-level section in the private config (`houses`, `bazaar`, …) replaces the same section of `config.yaml`.

## Setup

1. **Pushover**: install the iOS app (and [Pushover for Desktop](https://pushover.net/clients/desktop) on the Mac). Copy your *User Key*, then [create an application](https://pushover.net/apps/build) to get an *API Token*.
2. **Secrets** (run from the repo folder, and paste each value when asked):
   ```sh
   gh secret set PUSHOVER_USER
   gh secret set PUSHOVER_TOKEN
   gh secret set TRACKER_CONFIG < config.local.yaml
   gh secret set STATE_KEY < .secrets/state.key
   ```
   To create the key: `mkdir -p .secrets && python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())" > .secrets/state.key`. Keep a backup: without it the stored state can't be read, and the tracker would start over with a fresh baseline.
3. **First run**: go to *Actions → Tibia tracker → Run workflow*. You should get the "Tracking started" push.

The workflow runs once a day at 13:00 UTC (10:00 in Uruguay). GitHub may start scheduled runs late, usually by 5–30 minutes.

**Changing filters:** edit `config.local.yaml`, then run `gh secret set TRACKER_CONFIG < config.local.yaml`.

## Local use

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest
.venv/bin/python -m tracker --dry-run               # print instead of sending, don't save state
.venv/bin/python -m tracker --dry-run --only houses
```

Local runs use `config.local.yaml` and, if present, `.secrets/state.key`.

## Run on your Mac instead

Use this if GitHub Actions stops working for you, for example its schedule gets disabled or keeps failing. **Don't** use it to get around a block: if tibia.com or TibiaData halts the tracker, respect that. Look into why before resuming anywhere.

1. Copy the job file and load it. Put your Pushover keys **only in the copy** in `~/Library/LaunchAgents`: this repo is public, so never commit keys.
   ```sh
   mkdir -p logs
   cp launchd/com.pedro.tibiatracker.plist ~/Library/LaunchAgents/
   open -e ~/Library/LaunchAgents/com.pedro.tibiatracker.plist   # replace REPLACE_ME
   launchctl load ~/Library/LaunchAgents/com.pedro.tibiatracker.plist
   ```
2. Disable the scheduled `Tibia tracker` workflow so both don't run. launchd catches up on a missed run when the Mac wakes.
3. Keep the `Contact kill switch` workflow enabled. Local runs still respect `state/halt.json`, so run `git pull` before each run (or add it to the job) to pick up halts.

## Layout

```
tracker/config.py   public template + private overrides
tracker/houses.py   TibiaData → auctioned houses
tracker/bazaar.py   tibia.com bazaar → skill-filtered auctions (rate-limited)
tracker/state.py    (encrypted) state, diffing, failure streaks
tracker/guard.py    kill switch: block detection, halts, contact auto-reply
tracker/notify.py   message formatting + Pushover
tracker/__main__.py orchestration / CLI
```
