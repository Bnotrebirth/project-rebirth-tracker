/* =========================================================================
   Project Rebirth — Mothership watcher worker

   One Cloudflare Worker does everything (free plan friendly):

     cron every 2 min
       ├─ poll the game's server-browser list (GAME_API_URL secret)
       ├─ diff against the previous snapshot (core.js)  → alert events
       ├─ post events to a Discord webhook              (DISCORD_WEBHOOK_URL)
       ├─ append a player-count sample + peak-hours cell
       └─ persist KV

     HTTP
       ├─ /history.json      {samples}                       (back-compat)
       ├─ /api/state         live snapshot + region advice   (?continent=NA)
       ├─ /api/events        watcher event feed
       ├─ /api/patches       build-number timeline
       ├─ /api/restarts      restart forensics + stats
       ├─ /api/config        config-drift log
       ├─ /api/peak          day×hour concurrency matrix
       └─ anything else      static files from ./site

   KV budget (free plan: 1,000 writes/day):
     - `tracker` blob (samples + diff state + peak matrix + latest snapshot)
       is written once per cron tick  → 720 writes/day
     - `events` / `patches` / `restarts` / `configlog` logs are written ONLY
       when they actually change, so the remaining headroom is ample.
   ========================================================================= */

import { tick, advise, regionRollup, embedBatches } from "./core.js";
import { handleInteraction, verifyInteraction } from "./interactions.js";
import { restartForensics, patchRollout, patchStats, peakAnalytics } from "./analytics.js";
export { restartForensics, patchRollout, patchStats, peakAnalytics };

// The game API's location is configuration, never source: it lives in the
// GAME_API_URL secret (npx wrangler secret put GAME_API_URL) as the FULL
// request URL for the server-browser list, query string included. Nothing in
// this repo, and nothing in the deployed bundle's source, says where the
// backend is — only the worker does.
const MIN_GAP_MS = 60_000;              // collapse samples closer than 1 min
const MAX_AGE_MS = 30 * 24 * 3600e3;    // keep 30 days of samples
const MAX_SAMPLES = 25_000;             // hard cap regardless of age

// Ring-buffer caps for the event logs (KV stays small, APIs stay fast).
const CAP = { events: 200, patches: 100, restarts: 100, configlog: 80 };

const KV_TRACKER = "tracker";
const KV_EVENTS = "events";
const KV_PATCHES = "patches";
const KV_RESTARTS = "restarts";
const KV_CONFIG = "configlog";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });

// ------------------------------ KV bits ----------------------------------

async function readJson(env, key, fallback) {
  try {
    const raw = await env.HISTORY.get(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

async function readTracker(env) {
  const t = await readJson(env, KV_TRACKER, null);
  if (t && Array.isArray(t.samples)) return t;

  // Migration: seed from the old player-history-only blob if it exists.
  const legacy = await readJson(env, "player_history", null);
  return { samples: legacy?.samples || [], prev: null, peak: {}, latest: null };
}

async function writeTracker(env, t) {
  await env.HISTORY.put(KV_TRACKER, JSON.stringify(t));
}

/** Append to a log key, newest first, capped. Only writes when changed. */
async function appendLog(env, key, entries, cap) {
  if (!entries.length) return;
  const log = await readJson(env, key, []);
  const next = [...entries.slice().reverse(), ...log].slice(0, cap);
  await env.HISTORY.put(key, JSON.stringify(next));
}

// ------------------------------ game API ---------------------------------

/**
 * The backend's list URL, straight from the GAME_API_URL secret.
 * Throws if the secret is missing so the caller can log a clear error.
 */
function gameApiUrl(env) {
  const url = String(env.GAME_API_URL || "").trim();
  if (!url) {
    throw new Error(
      "GAME_API_URL is not configured — run: npx wrangler secret put GAME_API_URL"
    );
  }
  return url;
}

async function fetchStations(env) {
  const res = await fetch(gameApiUrl(env), {
    headers: { "User-Agent": "project-rebirth-tracker/2.0" },
  });
  if (!res.ok) throw new Error(`game API returned HTTP ${res.status}`);
  const json_ = await res.json();
  return json_.items || [];
}

// ------------------------------ discord ----------------------------------

function webhookUrls(env) {
  const raw = env.DISCORD_WEBHOOK_URL || "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

async function sendAlerts(env, events) {
  const urls = webhookUrls(env);
  if (!urls.length || !events.length) return;
  for (const url of urls) {
    for (const batch of embedBatches(events)) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(batch),
        });
        if (!res.ok) console.log(`discord webhook ${res.status}: ${(await res.text()).slice(0, 200)}`);
      } catch (err) {
        console.log("discord webhook failed:", err.message);
      }
    }
  }
}

// ------------------------------ cron -------------------------------------

async function cron(env) {
  let items;
  try {
    items = await fetchStations(env);
  } catch (err) {
    // Game API blip — keep the previous state so we don't false-alarm.
    console.log("stations fetch failed:", err.message);
    return;
  }

  const now = Date.now();
  const tracker = await readTracker(env);
  const { events, prev, bootstrapped } = tick(tracker.prev, items, now);

  // ---- player-count sample (same cadence rules as before) ----
  const total = prev.total_online;
  const samples = tracker.samples;
  const last = samples[samples.length - 1];
  if (last && now - last.t < MIN_GAP_MS) {
    last.t = now;
    last.v = total;
  } else {
    samples.push({ t: now, v: total });
  }
  const cutoff = now - MAX_AGE_MS;
  tracker.samples = samples.filter((s) => s.t >= cutoff).slice(-MAX_SAMPLES);

  // ---- peak-hours matrix (UTC) ----
  const d = new Date(now);
  const cellKey = `${d.getUTCDay()}_${d.getUTCHours()}`;
  const cell = (tracker.peak[cellKey] ||= { n: 0, sum: 0, max: 0 });
  cell.n += 1;
  cell.sum += total;
  cell.max = Math.max(cell.max, total);

  // ---- latest snapshot (drives /api/state + the region advisor) ----
  const deps = items.flatMap((s) =>
    (s.deployments || []).map((dd) => ({
      station: s.station_name || "",
      name: dd.deployment_name || "",
      region: dd.region || "UNK",
      ip: dd.ip || "",
      version: String(dd.version ?? ""),
      online: !!dd.online,
      players: Math.max(0, parseInt(dd.player_count, 10) || 0),
      created: dd.created || "",
      last_event: dd.last_event || "",
    }))
  );
  tracker.latest = {
    t: now,
    total,
    all_time_peak: prev.all_time_peak,
    servers: deps,
    regions: regionRollup(deps.map((x) => ({ region: x.region, online: x.online, players: x.players }))),
  };
  tracker.prev = prev;
  await writeTracker(env, tracker);

  // ---- route events into their logs (only write when something happened) ----
  if (events.length) {
    await appendLog(env, KV_EVENTS, events, CAP.events);
    const byType = (t) => events.filter((e) => e.type === t);
    await appendLog(env, KV_PATCHES, byType("patch"), CAP.patches);
    await appendLog(env, KV_RESTARTS, byType("restart"), CAP.restarts);
    await appendLog(env, KV_CONFIG, byType("config"), CAP.configlog);
  }

  if (bootstrapped) {
    console.log(`bootstrap complete: ${deps.length} deployments, total ${total}`);
  } else if (events.length) {
    console.log(`events: ${events.map((e) => e.type).join(", ")}`);
  }

  await sendAlerts(env, events);
}

// ------------------------------ routes -----------------------------------


export default {
  /** Static assets + JSON API routes. */
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    // Runtime self-test: does this Workers build support Ed25519 in
    // WebCrypto? Discord's handshake needs it. Reports booleans only.
    if (url.pathname === "/debug/crypto") {
      let supported = false;
      let err = null;
      try {
        const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
        const sig = await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, new Uint8Array([1, 2, 3]));
        supported = await crypto.subtle.verify({ name: "Ed25519" }, kp.publicKey, sig, new Uint8Array([1, 2, 3]));
      } catch (e) {
        err = e.message;
      }
      return json({ ed25519_supported: supported, error: err });
    }

    // Discord interactions endpoint (slash commands over HTTP — no gateway).
    // Signature must be checked against the RAW body, so read it first.
    if (url.pathname === "/interactions" && request.method === "POST") {
      const raw = await request.text();
      const ok = await verifyInteraction(
        env.DISCORD_PUBLIC_KEY,
        raw,
        request.headers.get("X-Signature-Ed25519") || "",
        request.headers.get("X-Signature-Timestamp") || ""
      );
      if (!ok) return new Response("invalid request signature", { status: 401 });

      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return new Response("bad json", { status: 400 });
      }
      const result = await handleInteraction(body, env);
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    }

    switch (url.pathname) {
      case "/history.json": {
        const t = await readTracker(env);
        return json({ samples: t.samples });
      }

      case "/api/state": {
        const t = await readTracker(env);
        const latest = t.latest || { t: null, total: 0, servers: [], regions: {}, all_time_peak: 0 };
        // Continent, in priority order:
        //   1. ?continent=  — the site passes the continent the game's own geo
        //                     call reported for this player
        //   2. request.cf   — Cloudflare geo-locates this HTTP client, so a
        //                     plain visit (curl, embeds) still gets advice
        //                     without knowing to ask
        const param = (url.searchParams.get("continent") || "").toUpperCase();
        const geo = String(request.cf?.continent || "").toUpperCase();
        const continent = param || geo || null;
        return json({
          generated_at: latest.t,
          total_online: latest.total,
          all_time_peak: latest.all_time_peak || 0,
          servers: latest.servers || [],
          regions: latest.regions || {},
          continent,
          advice: continent ? advise(latest.regions || {}, continent) : null,
        });
      }

      case "/api/events": {
        const limit = Math.min(100, parseInt(url.searchParams.get("limit"), 10) || 30);
        return json({ events: (await readJson(env, KV_EVENTS, [])).slice(0, limit) });
      }

      case "/api/patches": {
        const limit = Math.min(100, parseInt(url.searchParams.get("limit"), 10) || 20);
        const patches = await readJson(env, KV_PATCHES, []);
        const t = await readTracker(env);
        return json({
          patches: patches.slice(0, limit),
          rollout: patchRollout(t.latest?.servers || []),
          stats: patchStats(patches),
        });
      }

      case "/api/restarts": {
        const limit = Math.min(100, parseInt(url.searchParams.get("limit"), 10) || 20);
        const restarts = await readJson(env, KV_RESTARTS, []);
        const events = await readJson(env, KV_EVENTS, []);
        return json({
          restarts: restarts.slice(0, limit),
          stats: restartForensics(restarts, events),
        });
      }

      case "/api/config": {
        const limit = Math.min(100, parseInt(url.searchParams.get("limit"), 10) || 20);
        const signal = url.searchParams.get("signal");
        const all = await readJson(env, KV_CONFIG, []);
        const whitelist = all.filter((c) => c.signal === "whitelist");
        const changes = signal === "whitelist" ? whitelist : all;
        const t = await readTracker(env);
        const roster = t.prev?.roster || {};
        return json({
          changes: changes.slice(0, limit),
          whitelist_changes: whitelist.slice(0, limit),
          roster,
          roster_size: Object.values(roster).reduce((n, list) => n + (list?.length || 0), 0),
          signal: signal === "whitelist" ? "whitelist" : "all",
        });
      }

      case "/api/peak": {
        const t = await readTracker(env);
        return json({ generated_at: t.prev?.t ?? null, ...peakAnalytics(t.peak || {}) });
      }

      default:
        return env.ASSETS.fetch(request);
    }
  },

  /** Cron — fires every 2 minutes (see wrangler.toml). */
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(cron(env));
  },
};
