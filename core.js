/* =========================================================================
   Project Rebirth — Mothership watcher core (shared, pure logic)

   No imports, no I/O — this module runs identically inside the Cloudflare
   Worker (bundled by wrangler) and in plain Node for the test suite.

   `tick(prev, items, now)` compares the previous station snapshot with a
   fresh one from the game's server-browser list and produces:
     - a list of alert events (up/down, milestones, patches, restarts,
       stale heartbeats, config drift, region deaths, peak records)
     - the next diff-state blob to persist

   Design rules:
     - pure function of (prev, items, now) so tests can drive time manually
     - first run (no prev / version mismatch) BOOTSTRAPS silently: it seeds
       state from the current snapshot without emitting a storm of alerts
     - transition alerts (up/down/stale/death) go through a per-key cooldown
       so a flapping server doesn't spam Discord
   ========================================================================= */

export const STATE_VERSION = 3;

export const STALE_MS = 10 * 60_000;     // heartbeat older than this = "stale"
export const COOLDOWN_MS = 10 * 60_000;  // min gap between repeat transition alerts
export const CD_MAX_AGE_MS = 24 * 3600e3; // prune cooldown bookkeeping older than a day
export const PEAK_FLOOR = 25;            // don't announce "records" below this count

// Threshold ladders. SERVER_* fires per server instance, GLOBAL_* on the
// total-across-all-servers number. Instances reset when `created` changes.
export const SERVER_MILESTONES = [10, 25, 50, 75, 100, 150, 200, 300, 500, 750, 1000];
export const GLOBAL_MILESTONES = [25, 50, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000];

// Which game region codes belong to which continent (for the best-region
// advisor). Unknown continents fall back to "anywhere alive".
export const CONTINENT_REGIONS = {
  NA: ["NAE", "NAW"],
  EU: ["EU"],
  OC: ["OCE"],
  SA: ["SAC", "SA"],
  AS: ["ASIA", "AS", "JPN", "SG"],
  AF: ["EU"], // no African edge observed; closest sensible hop
};

const TRANSITION_TYPES = new Set([
  "server_up", "server_down", "stale", "recovered", "region_death", "region_rebirth",
]);

// ------------------------------ helpers ----------------------------------

const clip = (s, n) => {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

/** Locale-grouped number for display (1234567 → "1,234,567"). */
export const fmt = (n) => new Intl.NumberFormat().format(Number(n) || 0);

const parseIso = (s) => {
  if (!s) return NaN;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
};

export const fmtDur = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
};

/** Highest ladder rung <= value (0 if below every rung). */
function seedMs(ladder, value) {
  let m = 0;
  for (const th of ladder) if (value >= th) m = th;
  return m;
}

/**
 * Flatten a config object into { "a/b/0": "jsonvalue" } leaf paths so we can
 * diff nested settings key-by-key (arrays become indexed leaves).
 */
export function flattenCfg(obj, prefix = "", out = {}) {
  if (obj === null || typeof obj !== "object") {
    out[prefix || "(root)"] = JSON.stringify(obj ?? null);
    return out;
  }
  const keys = Object.keys(obj).sort();
  if (!keys.length) {
    out[prefix || "(root)"] = "{}";
    return out;
  }
  for (const k of keys) {
    flattenCfg(obj[k], prefix ? `${prefix}/${k}` : k, out);
  }
  return out;
}

/** [{key, from, to}] for every leaf that was added/removed/changed. */
export function diffConfig(prevCfg, curCfg) {
  const a = flattenCfg(prevCfg ?? {});
  const b = flattenCfg(curCfg ?? {});
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out = [];
  for (const k of [...keys].sort()) {
    if (a[k] === b[k]) continue;
    out.push({ key: k, from: a[k] ?? null, to: b[k] ?? null });
  }
  return out;
}

/* --------------------------------------------------------------------------
   Whitelist / roster signal (feature: pre-announcement of community events)

   Team*Whitelist settings hold a comma-separated list of the players who are
   allowed on a server — in practice, the roster for an upcoming scrim or
   tournament. Watching who joins/leaves that list is a leading indicator
   that an event is being set up, often before anything else is public.
   -------------------------------------------------------------------------- */

export const WHITELIST_KEY_RE = /whitelist/i;

/** "true"/"false"/numbers — settings that merely mention the word whitelist. */
const TOGGLE_RE = /^(true|false|-?\d+(\.\d+)?)$/i;

/** Does this value look like a list of player names rather than a toggle? */
const looksLikeRoster = (v) => {
  const raw = Array.isArray(v) ? v.join(",") : String(v ?? "").trim();
  // flattenCfg JSON-stringifies leaves, so `"false"` arrives with quotes —
  // strip them or a boolean would masquerade as a one-name roster.
  const s = raw.replace(/^["']|["']$/g, "").trim();
  return s !== "" && !TOGGLE_RE.test(s);
};

/**
 * True only for keys that both mention a whitelist AND carry a name list.
 * Guards against `bUseWhitelist: true/false` or `WhitelistCount: 16` being
 * reported as a player joining/leaving the roster.
 * Either side counts: a list being deleted entirely is still a roster event.
 */
export function isRosterKey(key, from, to) {
  return WHITELIST_KEY_RE.test(key) && (looksLikeRoster(from) || looksLikeRoster(to));
}

/** "gr3my, dizzy, Bnot," → ["gr3my","dizzy","Bnot"] (dupes collapsed). */
export function parseRoster(value) {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(",");
  const seen = new Set();
  const out = [];
  for (const piece of raw) {
    const name = String(piece).trim().replace(/^["']|["']$/g, "");
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

/** {added:[…], removed:[…]} for two roster strings/arrays (case preserved). */
export function rosterDelta(from, to) {
  const before = parseRoster(from);
  const after = parseRoster(to);
  const key = (s) => s.toLowerCase();
  const beforeKeys = new Set(before.map(key));
  const afterKeys = new Set(after.map(key));
  return {
    added: after.filter((s) => !beforeKeys.has(key(s))),
    removed: before.filter((s) => !afterKeys.has(key(s))),
  };
}

/**
 * Every whitelist-style key currently published, as { path: [names] }.
 * Rebuilt from the live snapshot each tick, so a removed deployment drops
 * out of the roster automatically.
 */
export function buildRoster(deps, stationConfigs = {}) {
  const roster = {};
  const ingest = (path, cfg) => {
    for (const [k, v] of Object.entries(flattenCfg(cfg ?? {}))) {
      if (!isRosterKey(k, v, v)) continue;
      roster[`${path}:${k}`] = parseRoster(v);
    }
  };
  for (const d of deps) ingest(`${d.region}/${d.name || d.id}`, d.config);
  for (const [sid, cfg] of Object.entries(stationConfigs)) ingest(`station/${sid}`, cfg);
  return roster;
}

/** Normalize the server-browser payload into flat dep records + station configs. */
export function normalize(items) {
  const deps = [];
  const stationConfigs = {};
  for (const s of items || []) {
    if (!s) continue;
    if (s.config && typeof s.config === "object") stationConfigs[s.station_id] = s.config;
    for (const d of s.deployments || []) {
      if (!d || !d.deployment_id) continue;
      deps.push({
        id: d.deployment_id,
        station_id: s.station_id,
        station_name: s.station_name || "",
        name: d.deployment_name || "",
        region: d.region || "UNK",
        ip: d.ip || "",
        version: String(d.version ?? ""),
        online: !!d.online,
        players: Math.max(0, parseInt(d.player_count, 10) || 0),
        created: d.created || "",
        last_event: d.last_event || "",
        config: d.config && typeof d.config === "object" ? d.config : {},
      });
    }
  }
  return { deps, stationConfigs };
}

/** Per-region rollup used by /api/state and the region advisor. */
export function regionRollup(deps) {
  const regions = {};
  for (const d of deps) {
    const r = (regions[d.region] ||= { code: d.region, servers: 0, online: 0, pop: 0 });
    r.servers += 1;
    if (d.online) {
      r.online += 1;
      r.pop += d.players;
    }
  }
  return regions;
}

/**
 * Best-region advisor.
 *
 * Input is the per-region rollup from the server-browser list (`online` +
 * `player_count`) merged with the caller's continent, which the site gets
 * from the game's own geo call. Two jobs:
 *   1. verdict  — is my home continent healthy, degraded, or dead?
 *   2. options  — a scored shortlist of everywhere worth playing, so a player
 *      whose region is down gets an ordered fallback rather than a shrug.
 *
 * Score (0–100, additive, explainable):
 *   +40 geo match        — region belongs to the caller's continent
 *   +35 population       — share of the busiest region (queue quality/matchmaking)
 *   +15 availability     — fraction of that region's servers online
 *   +10 full health      — every server in the region is up
 * Offline regions are dropped from `options` entirely: recommending a dead
 * server is worse than recommending a distant alive one.
 */
export function advise(regions, continent) {
  const codes = Object.keys(regions || {});
  const res = {
    continent: continent || null,
    home_regions: [],
    status: "no_data",
    recommended: null,
    reason: "",
    options: [],
  };
  if (!codes.length) return res;

  const alive = (code) => {
    const r = regions[code];
    return r && r.online > 0;
  };

  const wanted = (CONTINENT_REGIONS[continent] || []).filter((p) =>
    codes.some((c) => c.toUpperCase().startsWith(p))
  );
  const home = codes.filter((c) => wanted.some((p) => c.toUpperCase().startsWith(p)));
  res.home_regions = home;

  // ---- scored shortlist of every region that is actually up ----
  const maxPop = Math.max(1, ...codes.filter(alive).map((c) => regions[c].pop));
  res.options = codes
    .filter(alive)
    .map((code) => {
      const r = regions[code];
      const isHome = home.includes(code);
      const health = r.servers ? r.online / r.servers : 0;
      const score = Math.round(
        (isHome ? 40 : 0) +
        35 * (r.pop / maxPop) +
        15 * health +
        (health === 1 ? 10 : 0)
      );
      const why = [
        isHome ? `in ${continent}` : null,
        `${fmt(r.pop)} players`,
        r.online === r.servers ? `${r.servers}/${r.servers} up` : `${r.online}/${r.servers} up`,
      ].filter(Boolean).join(" · ");
      return { code, score, pop: r.pop, online: r.online, servers: r.servers, home: isHome, why };
    })
    .sort((a, b) => b.score - a.score || b.pop - a.pop || a.code.localeCompare(b.code));

  if (home.length) {
    const up = home.filter(alive);
    // Top-scored region that is actually in the caller's continent: score
    // folds in health, so a half-deployed busy region loses to a healthy one.
    const bestHome = res.options.find((o) => o.home)?.code || null;

    if (up.length === home.length) {
      res.status = "home_up";
      res.recommended = bestHome;
      res.reason = `Your continent (${continent}) is fully online — play ${res.recommended}.`;
    } else if (up.length) {
      res.status = "home_partial";
      res.recommended = bestHome;
      res.reason = `Some ${continent} servers are down — ${res.recommended} is your best in-region option.`;
    } else {
      res.status = "home_down";
      res.recommended = res.options[0]?.code || null;
      res.reason = res.recommended
        ? `Every ${continent} server is offline — closest option is ${res.recommended} (expect higher ping).`
        : `Every ${continent} server is offline and nothing else is up either.`;
    }
    return res;
  }

  res.status = res.options.length ? "no_home_region" : "global_down";
  res.recommended = res.options[0]?.code || null;
  res.reason = res.recommended
    ? `No ${continent || "known"} region found — everything is on ${res.recommended}.`
    : "No online servers anywhere.";
  return res;
}

// ------------------------------ the tick ---------------------------------

/**
 * @param meta optional structured facts bolted onto the event top-level, so
 *   analytics endpoints can compute on them instead of parsing prose:
 *   patch    → {dep, region, version_from, version_to, created, downtime_s, since_prev_s}
 *   restart  → {dep, region, created_from, created_to, downtime_s, players_before}
 *   stale    → {dep, region, age_s}
 *   up/down  → {dep, region}
 *   config   → {dep, region, signal, added, removed}
 *   The extra keys are ignored by eventToEmbed (display path) and survive
 *   verbatim into /api/* (analysis path).
 */
function makeEvent(now, type, title, body, fields, meta) {
  return { t: now, type, title, body: body || "", fields: fields || [], ...(meta || {}) };
}

function field(name, value) {
  return { name, value: clip(value, 250) };
}

/**
 * Compare snapshots and emit events.
 * @param prev  previous diff-state (or null/undefined on first run)
 * @param items parsed `items[]` from the game's server-browser list
 * @param now   epoch ms (injected so tests control time)
 * @returns {{events: object[], prev: object, bootstrapped: boolean}}
 */
export function tick(prev, items, now) {
  const { deps, stationConfigs } = normalize(items);

  const total = deps.reduce((n, d) => n + (d.online ? d.players : 0), 0);
  const regions = regionRollup(deps);

  // ---- bootstrap: seed silently, no alerts ----
  if (!prev || prev.v !== STATE_VERSION) {
    return {
      events: [],
      bootstrapped: true,
      prev: buildPrev(deps, stationConfigs, { total, regions, now, seedMsAll: true }),
    };
  }

  const events = [];
  const cd = { ...(prev.cooldown || {}) };
  // Regions whose only activity this tick is a patch/restart redeploy —
  // don't scream "region dead" mid-redeploy.
  const redeployRegions = new Set();
  // Milestone rungs already announced this tick (dedupes global vs server).
  const announcedRungs = new Set();

  /** Transition alert gate: at most one alert per key per COOLDOWN_MS. */
  const allow = (key) => {
    const last = cd[key];
    if (last && now - last < COOLDOWN_MS) return false;
    cd[key] = now;
    return true;
  };

  const prevDeps = prev.deps || {};
  const curIds = new Set();
  const curMap = {};

  for (const d of deps) {
    curIds.add(d.id);
    const p = prevDeps[d.id];
    const label = `${d.name || d.id} · ${d.region}`;
    const instance = `${d.id}|${d.created}`;
    const wasOnline = p ? p.online : false;
    const createdChanged = !!(p && d.created && p.created !== d.created);
    const versionChanged = !!(p && d.version && p.version !== d.version);
    // Seconds since we last observed this deployment alive. If we caught it
    // mid-outage this is a measured downtime; if the instance cycled without
    // ever appearing offline between two ticks it is a lower bound.
    const downtimeMs = p ? Math.max(0, now - (p.offline_since ?? p.last_online_t ?? now)) : 0;
    const downtime_s = p && downtimeMs > 0 ? Math.round(downtimeMs / 1000) : null;
    // Hours since this deployment last bumped its build (null until we've
    // seen a patch for it) — turns the patch log into a real release cadence.
    const since_prev_s = p?.patch_t ? Math.round((now - p.patch_t) / 1000) : null;

    // This object IS the next persisted state for this deployment — every
    // field updated below survives into the next tick.
    const cur = {
      name: d.name,
      region: d.region,
      ip: d.ip,
      version: d.version,
      online: d.online,
      players: d.players,
      created: d.created,
      instance,
      stale: false,
      ms: p ? p.ms : 0,
      last_online_t: d.online ? now : (p?.last_online_t ?? now),
      offline_since: d.online ? null : (p?.offline_since ?? now),
      last_players: d.online ? d.players : (p?.last_players ?? d.players),
      patch_t: p?.patch_t ?? null,   // last build bump we observed
      config: d.config,
    };

    // ---- patch / restart (a redeploy gives a fresh `created`) ----
    if (p && (versionChanged || createdChanged)) {
      const redeployed = versionChanged && createdChanged;
      if (versionChanged) {
        cur.patch_t = now;
        events.push(makeEvent(now, "patch",
          `Patch: ${label}`,
          `${d.name || d.id} in ${d.region} updated build ${p.version} → ${d.version}.` +
            (redeployed ? ` Redeployed (downtime ~${fmtDur(downtimeMs)}).` : ""),
          [field("Region", d.region), field("Connect", d.ip),
           field("Deployed", d.created || "unknown")],
          { dep: d.id, region: d.region, version_from: p.version, version_to: d.version,
            created: d.created || "", downtime_s, since_prev_s,
            players_before: p?.last_players ?? p.players }));
      } else {
        events.push(makeEvent(now, "restart",
          `Server restarted: ${label}`,
          d.online
            ? `${d.name || d.id} in ${d.region} came back as a new instance.` +
              (wasOnline || p.offline_since ? ` Downtime ~${fmtDur(downtimeMs)}.` : "")
            : `${d.name || d.id} in ${d.region} is cycling — new instance detected while offline.`,
          [field("Region", d.region), field("Last seen", `${p.players} players`),
           field("Build", d.version || p.version)],
          { dep: d.id, region: d.region, created_from: p.created, created_to: d.created,
            downtime_s, players_before: p?.last_players ?? p.players }));
      }
      // Fresh instance: re-seed the milestone ladder silently from the
      // current count so old-instance progress doesn't re-alert.
      cur.ms = seedMs(SERVER_MILESTONES, d.players);
      redeployRegions.add(d.region);
    } else if (p) {
      // ---- online/offline transitions ----
      if (d.online && !wasOnline && allow(`server_up:${d.id}`)) {
        events.push(makeEvent(now, "server_up",
          `Server online: ${label}`,
          `${d.name || d.id} is up in ${d.region} — build ${d.version || "?"}.`,
          [field("Connect", d.ip), field("Players", d.players)],
          { dep: d.id, region: d.region }));
      } else if (!d.online && wasOnline && allow(`server_down:${d.id}`)) {
        events.push(makeEvent(now, "server_down",
          `Server offline: ${label}`,
          `${d.name || d.id} in ${d.region} went offline (was ${p.players} players).`,
          [field("Region", d.region)],
          { dep: d.id, region: d.region }));
      }
    } else {
      // Brand-new deployment id we've never seen.
      if (allow(`server_up:${d.id}`)) {
        events.push(makeEvent(now, "server_up",
          `Server online: ${label}`,
          `New deployment for ${d.name || d.id} in ${d.region}.`,
          [field("Connect", d.ip), field("Build", d.version), field("Players", d.players)],
          { dep: d.id, region: d.region }));
      }
      cur.ms = seedMs(SERVER_MILESTONES, d.players);
    }

    // ---- heartbeat staleness ----
    const age = now - parseIso(d.last_event);
    cur.stale = d.online && Number.isFinite(age) ? age > STALE_MS : false;
    if (p && !d.online) cur.stale = false;
    if (p && cur.stale && !p.stale && allow(`stale:${d.id}`)) {
      events.push(makeEvent(now, "stale",
        `Heartbeat stale: ${label}`,
        `${d.name || d.id} in ${d.region} hasn't checked in for ${fmtDur(age)} — the server may be dying.`,
        [field("Last event", d.last_event || "never")],
        { dep: d.id, region: d.region, age_s: Math.round(age / 1000) }));
    } else if (p && !cur.stale && p.stale && d.online && allow(`recovered:${d.id}`)) {
      events.push(makeEvent(now, "recovered",
        `Heartbeat recovered: ${label}`,
        `${d.name || d.id} in ${d.region} is reporting normally again.`,
        [],
        { dep: d.id, region: d.region }));
    }

    // ---- per-server milestones ----
    if (d.online && d.players > cur.ms) {
      const crossed = SERVER_MILESTONES.filter((th) => th <= d.players && th > cur.ms);
      if (crossed.length) {
        const hit = crossed[crossed.length - 1];
        cur.ms = hit;
        announcedRungs.add(hit);
        events.push(makeEvent(now, "milestone",
          `${d.players} players online: ${label}`,
          `${d.name || d.id} in ${d.region} just hit ${d.players} players (previous best this run: ${p ? p.ms : 0}).`,
          [field("Region", d.region), field("Connect", d.ip)]));
      }
    }

    // ---- config drift (whitelist edits are promoted to a roster signal) ----
    const cfgDiff = diffConfig(p ? p.config : d.config, d.config);
    if (p && cfgDiff.length) {
      const shown = cfgDiff.slice(0, 8);
      const wl = cfgDiff.filter((c) => isRosterKey(c.key, c.from, c.to));
      const meta = { dep: d.id, region: d.region };
      let body =
        `${cfgDiff.length} setting${cfgDiff.length === 1 ? "" : "s"} changed on ${d.name || d.id}.`;

      if (wl.length) {
        // The names are the story: who joined/left tells you an event is
        // being organised before anything is announced.
        const added = new Set();
        const removed = new Set();
        for (const c of wl) {
          const delta = rosterDelta(c.from, c.to);
          for (const n of delta.added) added.add(n);
          for (const n of delta.removed) removed.add(n);
        }
        meta.signal = "whitelist";
        meta.added = [...added];
        meta.removed = [...removed];
        meta.keys = wl.map((c) => c.key);

        const bits = [];
        if (added.size) bits.push(`${added.size} joined: ${clip([...added].join(", "), 160)}`);
        if (removed.size) bits.push(`${removed.size} left: ${clip([...removed].join(", "), 160)}`);
        body = bits.length
          ? `Whitelist roster change — ${bits.join(" · ")}.`
          : `Whitelist edited (${wl.length} list${wl.length === 1 ? "" : "s"} changed) but the roster is unchanged.`;
      }

      events.push(makeEvent(now, "config",
        wl.length ? `Whitelist changed: ${label}` : `Config changed: ${label}`,
        body,
        shown.map((c) => field(c.key, `${c.from ?? "—"} → ${c.to ?? "—"}`)),
        meta));
    }

    curMap[d.id] = cur;
  }

  // ---- deployments that vanished entirely ----
  for (const [id, p] of Object.entries(prevDeps)) {
    if (curIds.has(id)) continue;
    const label = `${p.name || id} · ${p.region}`;
    if (p.online && allow(`server_down:${id}`)) {
      events.push(makeEvent(now, "server_down",
        `Server removed: ${label}`,
        `${p.name || id} disappeared from ${p.region} while it had ${p.players} players.`,
        [field("Region", p.region)],
        { dep: id, region: p.region }));
    }
  }

  // ---- station-level config drift ----
  const prevStationCfg = prev.stationConfigs || {};
  const curStationKeys = new Set(Object.keys(stationConfigs));
  for (const [sid, cfg] of Object.entries(stationConfigs)) {
    const diff = diffConfig(prevStationCfg[sid], cfg);
    if (prevStationCfg[sid] && diff.length) {
      events.push(makeEvent(now, "config",
        "Station config changed",
        `${diff.length} station-level setting(s) changed.`,
        diff.slice(0, 8).map((c) => field(c.key, `${c.from ?? "—"} → ${c.to ?? "—"}`))));
    }
  }
  for (const sid of Object.keys(prevStationCfg)) {
    if (!curStationKeys.has(sid)) {
      events.push(makeEvent(now, "config", "Station config removed",
        `Station ${sid} no longer publishes config.`, []));
    }
  }

  // ---- region deaths / rebirths ----
  // Two guards against noise:
  //  - skip regions mid-redeploy (patch/restart just fired) — "region dead"
  //    during a 2-minute rolling update is a false alarm
  //  - only fire for regions with >= 2 deployments — with a single server,
  //    region death is the same fact as server_down, already announced
  const prevRegions = prev.regions || {};
  for (const [code, r] of Object.entries(regions)) {
    if (redeployRegions.has(code) || r.servers < 2) continue;
    const before = prevRegions[code] || 0;
    if (before > 0 && r.online === 0 && allow(`region_death:${code}`)) {
      events.push(makeEvent(now, "region_death",
        `Region dead: ${code}`,
        `Every server in ${code} is offline.`,
        [field("Servers", r.servers)]));
    } else if (before === 0 && r.online > 0 && allow(`region_rebirth:${code}`)) {
      events.push(makeEvent(now, "region_rebirth",
        `Region back online: ${code}`,
        `${r.online} server${r.online === 1 ? " is" : "s are"} up in ${code} again.`,
        [field("Players", r.pop)]));
    }
  }

  // ---- global milestones + all-time peak ----
  let globalMs = prev.global_ms ?? 0;
  if (total > globalMs) {
    const crossed = GLOBAL_MILESTONES.filter((th) => th <= total && th > globalMs);
    if (crossed.length) {
      const hit = crossed[crossed.length - 1];
      globalMs = hit;
      // If a per-server milestone already announced the same number this
      // tick (single-server game = total === server count), don't repeat it.
      if (!announcedRungs.has(hit)) {
        events.push(makeEvent(now, "global_milestone",
          `${hit} players online globally!`,
          `Project Rebirth just passed ${hit} concurrent players across every server.`,
          []));
      }
    }
  }
  let peak = prev.all_time_peak ?? 0;
  if (total > peak) {
    peak = total;
    // Only announce records worth caring about, and never repeat the exact
    // number a global milestone just announced.
    if (total >= PEAK_FLOOR && !announcedRungs.has(total)) {
      events.push(makeEvent(now, "peak_record",
        `New all-time peak: ${total} players!`,
        `That's the highest concurrent count this watcher has ever seen.`,
        [field("Previous peak", prev.all_time_peak ?? 0)]));
    }
  }

  const next = {
    v: STATE_VERSION,
    t: now,
    total_online: total,
    all_time_peak: Math.max(peak, total),
    global_ms: Math.max(globalMs, seedMs(GLOBAL_MILESTONES, total)),
    regions: Object.fromEntries(Object.entries(regions).map(([c, r]) => [c, r.online])),
    deps: curMap,
    stationConfigs,
    roster: buildRoster(deps, stationConfigs),
    cooldown: {},
  };
  // prune dead cooldown keys so the blob doesn't grow forever
  for (const [k, t] of Object.entries(cd)) {
    if (now - t < CD_MAX_AGE_MS) next.cooldown[k] = t;
  }

  return { events, prev: next, bootstrapped: false };
}

/** Build the persisted diff-state from a normalized snapshot. */
function buildPrev(deps, stationConfigs, { total, regions, now, seedMsAll = false }) {
  const map = {};
  for (const d of deps) {
    const instance = `${d.id}|${d.created}`;
    const age = now - parseIso(d.last_event);
    map[d.id] = {
      name: d.name,
      region: d.region,
      ip: d.ip,
      version: d.version,
      online: d.online,
      players: d.players,
      created: d.created,
      instance,
      stale: d.online && Number.isFinite(age) ? age > STALE_MS : false,
      ms: seedMsAll ? seedMs(SERVER_MILESTONES, d.players) : 0,
      last_online_t: d.online ? now : now,
      offline_since: d.online ? null : now,
      last_players: d.players,
      patch_t: null,          // no patch observed yet — first bump seeds it
      config: d.config,
    };
  }
  const regionCounts = {};
  for (const [code, r] of Object.entries(regions)) regionCounts[code] = r.online;
  return {
    v: STATE_VERSION,
    t: now,
    total_online: total,
    all_time_peak: seedMsAll ? total : 0,
    global_ms: seedMsAll ? seedMs(GLOBAL_MILESTONES, total) : 0,
    regions: regionCounts,
    deps: map,
    stationConfigs,
    roster: buildRoster(deps, stationConfigs),
    cooldown: {},
  };
}

// ------------------------------ Discord ----------------------------------

export const EVENT_COLORS = {
  server_up: 0x3ddc97,
  server_down: 0xdc3545,
  stale: 0xffc14d,
  recovered: 0x4d8dff,
  milestone: 0xffd166,
  global_milestone: 0xffd166,
  peak_record: 0x00ffe1,
  patch: 0x4d8dff,
  restart: 0xff9f43,
  config: 0xa66bff,
  region_death: 0x8b1e2b,
  region_rebirth: 0x28a745,
};

/** One watcher event -> one Discord embed object. */
export function eventToEmbed(ev) {
  const fields = (ev.fields || []).slice(0, 8).map((f) => ({
    name: clip(f.name, 256),
    value: clip(f.value ?? "—", 1024) || "—",
  }));
  return {
    title: clip(ev.title, 256),
    description: clip(ev.body, 900) || undefined,
    color: EVENT_COLORS[ev.type] ?? 0x9fb0cd,
    fields: fields.length ? fields : undefined,
    timestamp: new Date(ev.t).toISOString(),
    footer: { text: "Project Rebirth Watcher" },
  };
}

/** Chunk events into webhook payloads (Discord allows 10 embeds/message). */
export function embedBatches(events, per = 10) {
  const out = [];
  for (let i = 0; i < events.length; i += per) {
    const chunk = events.slice(i, i + per);
    out.push({
      content: chunk.length > 1 ? `**${chunk.length} watcher events**` : undefined,
      embeds: chunk.map(eventToEmbed),
      allowed_mentions: { parse: [] },
    });
  }
  return out;
}
