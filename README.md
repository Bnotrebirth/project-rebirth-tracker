# Project Rebirth — Live Server Tracker

A static website that shows every Project Rebirth server that is currently up and how
many people are online in each one. No build step, no backend, no dependencies —
just open `index.html` or host it anywhere (GitHub Pages, Netlify, Cloudflare Pages, itch.io, etc.).

## The API

The game (`A2-Win64-Shipping.exe`) talks to a backend it calls **"Mothership"** at:

```
https://api.cosmovr.org
```

The base URL is hardcoded in `ServerBrowser.cpp` and can also be overridden at launch
(e.g. the game was launched here with `-dashboardapiurl=https://api.cosmovr.org`).

### Public endpoints (no auth needed)

| Method | Path | Notes |
| ------ | ---- | ----- |
| `GET` | `/` | `{"service":"Mothership API","version":"1.0.0","status":"running","sdk_version":"v2025.11.24.1"}` |
| `GET` | `/health` | `{"status":"healthy","timestamp":"..."}` |
| `GET` | `/v1/region` | `{"continent_code":"NA","country_code":"US"}` (based on caller IP) |
| `GET` | `/v1/stations` | Paginated list of stations (game worlds) |

### The server list call used by this site

```http
GET https://api.cosmovr.org/v1/stations?include_deployments=true&include_config=true&page=1&page_size=100
```

Real response:

```json
{
  "page": { "total_items": 1, "item_count": 1, "page_size": 100, "page": 1, "pages": 1 },
  "items": [
    {
      "station_id": "0763465670b8437781763f05ecd3a9c4",
      "station_name": "Communities",
      "created": "2026-10-17T21:04:08.062-04:00",
      "deployments": [
        {
          "deployment_id": "4156061d15914e21a0e925f91fbc8c77",
          "station_id": "0763465670b8437781763f05ecd3a9c4",
          "deployment_name": "Communities",
          "region": "NAE",
          "ip": "45.8.201.127:7777",
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

Query parameters:

- `include_deployments=true` — attach the live game servers (this is the important one)
- `include_config=true` — attach station config JSON
- `page` / `page_size` — pagination (`page_size` caps at 100)

### Auth-protected endpoints (require a login token / API key headers)

These exist in the binary but return `401 Unauthorized` without a session:

- `POST /v2/users/log_in`, `POST /v1/users/log_in_with_key`
- `POST /v2/player/client/auth/begin/QUEST` + `/complete/QUEST` (Meta Quest attestation)
- `GET /v1/title-data`, `GET /v1/inventory`, `GET /v1/storefront/client`
- `POST /v1/purchase`, `POST /v1/purchase/client/refresh-iap`
- `GET /v1/moderation`, `POST /v1/moderation/{client,server}/report`
- `POST /v1/server/player/auth/verify_token`
- `POST /v1/%s/analytics/event/batch` (org-name segment substituted)

Auth headers used by the client:
`x-mothership-org-id`, `x-mothership-title-id`, `x-mothership-env-id`,
`x-mothership-deployment-id`, `x-mothership-token`, `x-automation-key`,
`x-server-api-key`, `x-mothership-sdk-version`.

### CORS

The API sends `Access-Control-Allow-Origin: *` and `Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS`,
so a plain browser page can fetch it directly. **No proxy or serverless function is needed.**

## Other endpoints found in the binary

The game also runs a *local* HTTP server (used by the in-game spectator/overlay web UI):

```
http://127.0.0.1:5420/ui
/state, /state/all_frames, /state/local_player
/debug/players/presence
/replays/list, /replays/download
/cameras/docs
```

That one is local-only, so it can't power a public website.

## Run it

Just open `index.html` in a browser, or:

```bash
cd project-rebirth-tracker
python -m http.server 8080
# → http://localhost:8080
```

Features: live player totals, per-server population bars, region filter chips,
search, sorting, copy-to-clipboard server addresses, stale-server detection,
30s auto-refresh with a countdown, and graceful handling if the API goes down.

> Note: this reads only public data from the game's own server browser endpoint.
> Please keep the refresh interval reasonable (30s+) so the API isn't hammered.
