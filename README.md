# Project Rebirth — Live Server Tracker + Watcher

A static website + Cloudflare Worker + Discord bot suite for Project Rebirth.
The worker polls the game API every 2 minutes, diffs the snapshot, and pushes
alerts to Discord; the site visualizes live counts, history, patches,
restarts, config drift, and peak hours; the bot answers slash commands on demand.

## The endpoint is a secret, not a constant

Nothing in this repository — no source file, no workflow, no docs, no
committed config — says where the game API lives. The one URL the project
needs is stored as configuration:

| Where | Name | How to set it |
| ----- | ---- | ------------- |
| Cloudflare Worker (cron + `/interactions` fallback) | `GAME_API_URL` | `npx wrangler secret put GAME_API_URL` |
| GitHub Actions (`collect.py`) | `GAME_API_URL` | repo **Settings → Secrets and variables → Actions** |
| Local dev / manual sampling | `GAME_API_URL` | gitignored `.dev.vars` (wrangler) or `.env` |
| Discord bot (worker-down fallback) | `GAME_API_URL` | env var, or `bot/config.json` (gitignored) |

The value is the **full request URL** for the server-browser list, query
string included. It is never echoed back by any endpoint and never reaches
the browser: the browser only ever talks to this project's own worker.

That separation is the point of the whole design:

```
                                ┌── the endpoint lives ONLY here ──┐
                                │  GAME_API_URL (secret)           │
                                ▼                                  │
game API  ◀──cron 2m──  Cloudflare Worker (worker.js + core.js) ───┘
                          │  KV: history samples, diff state,
                          │      event logs, peak matrix
                          ├─▶ Discord webhook alerts
                          └─▶ /history.json + /api/*  (this project's own API)
                                   ▲
                site (site/)  ─────┤  fetches /api/* ONLY — same-origin
                                   │
 GitHub Pages copy (index.html) ───┘  fetches the worker's /api/* —
                                      the page has no idea where the
                                      game backend is, so neither does
                                      anyone with devtools open

Discord  ──POST /interactions──▶  worker verifies Ed25519 signature
                                  (interactions.js — no gateway, no process)
```

Open devtools on either site and you will only ever see requests to the
worker. There is no direct browser → game-API call anywhere, which is why
the endpoints can't leak out of the page.

Everything is pure ESM, no build step. Two shared modules, both imported by
the worker and the test suite:

- **`core.js`** — the diff/alert engine: snapshot diffing, event emission,
  roster extraction, the best-region advisor.
- **`analytics.js`** — pure functions over the event logs: rollout state,
  restart forensics, peak-hours rollups. Shared so the HTTP API and the
  slash commands report identical numbers.

## The data the endpoint returns

Paginated stations (game worlds); with deployments attached, each station
carries the live game servers:

```jsonc
{
  "page": { "total_items": 1, "item_count": 1, "page_size": 100, "page": 1, "pages": 1 },
  "items": [
    {
      "station_id": "…",
      "station_name": "Communities",
      "created": "2026-10-17T21:04:08.062-04:00",
      "deployments": [
        {
          "deployment_id": "…",
          "deployment_name": "Communities",
          "region": "NAE",
          "ip": "…:7777",
          "version": "22284",
          "created": "2026-10-17T21:04:10.046-04:00",
          "online": true,
          "last_event": "2026-10-17T22:14:06.463-04:00",
          "player_count": 35,
          "config": {}
        }
      ],
      "config": null
    }
  ]
}
```

- `online` → is the server currently up
- `player_count` → how many people are in that server
- `last_event` → last heartbeat from the dedicated server (used to flag stale servers)
- `ip` → the actual game server address (`connect <ip>` in-game)
- `region` → e.g. `NAE` (game regions are NA / EU / OCE)

Pagination: `page` / `page_size`, with `page_size` capped at 100. Only the
public, no-auth list endpoint is used — this project never logs in and never
sends credentials.

A second public call geo-locates the caller by IP (`continent_code` /
`country_code`) — that's how the game decides where to route you. The worker
uses Cloudflare's own geo of the HTTP client instead, so the site doesn't
need to make that call at all.

## Worker endpoints (this project's own API)

The worker exposes its own JSON API (all CORS-open, `no-store`):

| Path | Returns |
| ---- | ------- |
| `GET /history.json` | `{samples:[{t,v}]}` — 30 days of player counts (back-compat) |
| `GET /api/state?continent=NA` | live snapshot, per-region rollup, `advice` + scored `options`. Continent comes from `?continent=` or, failing that, Cloudflare's geo of the caller — so a plain visit already gets advice |
| `GET /api/events?limit=30` | watcher event feed (up/down, milestones, patches, restarts, config, regions) |
| `GET /api/patches?limit=20` | `{patches, rollout, stats}` — the update timeline |
| `GET /api/restarts?limit=20` | `{restarts, stats}` — crash forensics |
| `GET /api/config?limit=20` | `{changes, whitelist_changes, roster, roster_size}` — `?signal=whitelist` filters to roster events only |
| `GET /api/peak` | `{cells, by_day, by_hour, weekend, weekday, best_hours, best_windows}` |
| `POST /interactions` | Discord slash-command endpoint (Ed25519-verified) |

These are this project's API and are meant to be public. The game API is not,
and none of them proxy to it live: they answer out of KV, which the cron
keeps warm.

## The five analytics views

The official changelog is zero bytes, so everything below is inferred from
what the server-browser list actually publishes.

**1. Patch detector** — `version` + `created` per deployment.
Each build bump becomes a structured record (`version_from` → `version_to`,
instance `created` time, observed downtime, hours since that deployment's
previous bump), and `/api/patches` adds the rollout view: the newest build
seen anywhere, which build each region is running, and who's still behind —
a staged rollout you can watch happen.

**2. Crash/restart forensics** — `last_event` heartbeat and `created` churn.
A heartbeat going stale (`>10 min`) is the early warning; a fresh `created`
is the crash itself. `/api/restarts` reports restarts per calendar day, true
MTBF (mean gap between observed restarts, not `24 ÷ count`), downtime
average/median, and how often the stale warning actually preceded a crash —
with the median lead time it bought you.

**3. Config-drift / whitelist watcher** — `Team*Whitelist` settings.
These hold the roster of players allowed on a server, which in practice is
who's playing the upcoming scrim or tournament. Changes are flagged with the
joined/left names, the live roster is served in `/api/config`, and the events
are titled "Whitelist changed" rather than buried as an ordinary setting.
Boolean keys like `bUseWhitelist` are excluded so a toggle flip can never
read as a player joining.

**4. Peak-hours intelligence** — 60-second samples.
The day×hour matrix plus sample-weighted rollups: average players by
day-of-week, by hour-of-day, weekend vs weekday, and the busiest contiguous
4-hour window for each day (each hour must clear a 3-sample floor, so a
single quiet Tuesday can't be recommended as a session slot).

**5. Best-region advisor** — caller geo + per-region population.
The advisor merges where the caller is (Cloudflare geo, or `?continent=`)
with the per-region `online`/`player_count` rollup and returns a scored
shortlist: +40 geo match, +35 share of the busiest region (queue quality),
+15 server availability, +10 full health. Offline regions are excluded
outright — recommending a dead server is worse than a distant live one.

## Discord alerts

`core.js` diffs consecutive snapshots and emits typed events, pushed to one or
more Discord webhooks (color-coded embeds):

| Event | Fires when |
| ----- | ---------- |
| 🟢 `server_up` / 🔴 `server_down` | a deployment flips online/offline |
| 🟡 `stale` / 🔵 `recovered` | heartbeat (`last_event`) goes >10 min quiet, then returns |
| 📈 `milestone` / `global_milestone` | per-server ladder 10/25/50/75/100/150/... or global total crosses one |
| 🏆 `peak_record` | new all-time peak (≥25 players) |
| 🧩 `patch` | `version` bump (build 22284 → 22285) |
| 🔄 `restart` | `created` changes (new instance) — includes downtime |
| 🔧 `config` | config leaf keys change; whitelist edits are titled "Whitelist changed" with the joined/left names |
| 💀 `region_death` / ✨ `region_rebirth` | a multi-server region empties/refills |

Anti-spam: first tick bootstraps silently (no alert storm), transition events
have a 10-min per-key cooldown, mid-redeploy region changes are suppressed,
and identical milestone rungs aren't double-announced.

## Discord slash commands (serverless)

There is **no gateway bot process and nothing running 24/7.** Discord POSTs
each slash-command interaction to the worker's `/interactions` route, which
verifies the Ed25519 signature against `DISCORD_PUBLIC_KEY` and answers —
no websocket, no PC, no hosting cost.

```
/pr status              live totals + per-server breakdown
/pr region [continent]  best-region advisor + scored shortlist
/pr peak [days]         busiest hours, day-of-week rollup, 4h session windows
/pr patches [n]         rollout state + update timeline
/pr restarts [n]        MTBF, restarts/day, early-warning accuracy
/pr config [n]          live whitelist roster + recent join/leave
/pr events [n]          raw event feed
/pr history [range]     concurrency summary (24h/7d/30d)
```

Reading KV directly (no circular imports), so a command answers in a single
subrequest even when the game API is down.

## Setup

```bash
# 1. KV namespace (one-time) — paste the id into wrangler.toml
npm run kv:create

# 2. THE endpoint — the one secret this project cannot work without.
#    Value = the full server-browser request URL (query string included).
#    Nothing else in the repo carries it.
npx wrangler secret put GAME_API_URL

# 3. Discord webhook in "Project Rebirth test"
#    Server Settings → Integrations → Webhooks → New Webhook → Copy URL
npm run secret:webhook        # paste the URL when prompted

# 4. Application public key (Developer Portal → General Information →
#    Public Key) — the worker verifies every interaction signature with it
npx wrangler secret put DISCORD_PUBLIC_KEY

# 5. Deploy the worker (serves the site + API + alerts + slash commands)
npm run deploy

# 6. Command tree — copies bot/config.example.json → bot/config.json,
#    fill in token / application id / guild id
cd bot && npm install && cd ..
npm run bot:register          # registers /pr instantly for the guild
```

Then one final one-time call telling Discord where to send interactions
(this validates the endpoint itself before saving it — a broken verifier is
rejected with a `400`):

```bash
curl -X PATCH "https://discord.com/api/v9/applications/<APP_ID>" \
     -H "Authorization: Bot <TOKEN>" -H "Content-Type: application/json" \
     -d '{"interactions_endpoint_url":"https://project-rebirth-tracker.project-rebirth-tracker.workers.dev/interactions"}'
```

That's the whole bot: **no process to keep running.** Discord POSTs to the
worker, which verifies `DISCORD_PUBLIC_KEY` and answers in one subrequest.
(`bot/` only holds the command definitions used to register the tree —
`npm run bot` starts the legacy gateway bot and is not needed.)

The GitHub Pages copy (`index.html` + `app.js` at the repo root) can't proxy
anything, so it is told where the worker lives in one constant at the top of
`app.js` (`WORKER_ORIGIN`). It then fetches the worker's `/api/state` and
`/history.json` — never the game API. If you'd rather not publish even the
worker's address, just don't host that copy; the worker already serves the
full-featured `site/` version same-origin.

Local dev:

```bash
npm test                      # 78 tests: diff engine, analytics, slash commands
npx wrangler dev --test-scheduled   # GAME_API_URL comes from .dev.vars
# then trigger a tick:
curl -X POST "http://127.0.0.1:8787/cdn-cgi/local/explorer/api/local/scheduled?worker=project-rebirth-tracker" \
     -H "Content-Type: application/json" -d '{"cron":"* * * * *"}'
```

> Keep the refresh interval reasonable (30s+) so the game API isn't hammered —
> this only reads public data from the game's own server-browser endpoint.

## Reverse-engineering notes

Where the backend is, which internal endpoints exist, and how the client
authenticates are documented privately, not here. Public source should not
hand anyone a map of a live service: if you need those details, ask.

## Run it

```bash
cd project-rebirth-tracker
npx wrangler dev            # site + API on http://localhost:8787
```

Features: live player totals, per-server population bars, region filter chips,
search, sorting, copy-to-clipboard server addresses, stale-server detection,
30s auto-refresh with a countdown, graceful handling if the API goes down —
plus the watcher panels: live event feed, patch rollout strip, restart
forensics with per-day bars and early-warning accuracy, live whitelist roster
with join/leave movement, the UTC peak-hours heatmap with day-of-week
rollups, and a ranked region shortlist.
