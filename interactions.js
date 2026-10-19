/* =========================================================================
   Project Rebirth — Discord interactions endpoint (runs INSIDE the worker)

   This replaces the gateway bot entirely. Discord POSTs every slash command
   to /interactions; we verify the Ed25519 signature, read the same KV data
   the cron writes, and reply with an embed. No websocket, no process, no PC.

   Requires env.DISCORD_PUBLIC_KEY (from the Developer Portal → General
   Information → Public Key). The bot token is only needed once, to register
   the command tree and to point Discord at this URL — never at runtime.
   ========================================================================= */

import { advise } from "./core.js";
import { restartForensics, patchRollout, patchStats, peakAnalytics } from "./analytics.js";

// ------------------------------ helpers ----------------------------------

const fmt = (n) => new Intl.NumberFormat().format(Number(n) || 0);
const clip = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const ts = (epochMs) => (epochMs ? `<t:${Math.floor(epochMs / 1000)}:R>` : "never");

/** ISO timestamp → Discord `<t:…>` mention, or null if unparseable. */
const isoTs = (s) => {
  const ms = Date.parse(s || "");
  return Number.isFinite(ms) ? `<t:${Math.floor(ms / 1000)}>` : null;
};

/** Seconds → "270s" / "4m 30s" / "2h 5m" (zero components dropped). */
function dur(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "?";
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

const FLAGS = { NAE: "🇺🇸", NAW: "🇺🇸", EU: "🇪🇺", OCE: "🇦🇺", SAC: "🇧🇷", ASIA: "🌏" };
const flag = (r) => FLAGS[String(r || "").toUpperCase()] || "🌐";
const CYAN = 0x00ffe1;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function baseEmbed(title, description) {
  return {
    title: clip(title, 256),
    description: description ? clip(description, 4000) : undefined,
    color: CYAN,
    footer: { text: "Project Rebirth Watcher" },
    timestamp: new Date().toISOString(),
  };
}

async function readJson(env, key, fallback) {
  try {
    const raw = await env.HISTORY.get(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

const readTracker = (env) => readJson(env, "tracker", { samples: [], peak: {}, latest: null });

// Fallback for the rare case the cron hasn't written yet. The endpoint lives
// in the GAME_API_URL secret — the deployed code and this repo never say
// where the backend is.
async function mothershipNow(env) {
  const url = String(env.GAME_API_URL || "").trim();
  if (!url) throw new Error("GAME_API_URL is not configured");
  const res = await fetch(url, {
    headers: { "User-Agent": "project-rebirth-tracker/2.0" },
  });
  if (!res.ok) throw new Error(`game API HTTP ${res.status}`);
  const json = await res.json();
  const servers = (json.items || []).flatMap((s) =>
    (s.deployments || []).map((d) => ({
      station: s.station_name || "",
      name: d.deployment_name || "",
      region: d.region || "UNK",
      ip: d.ip || "",
      version: String(d.version ?? ""),
      online: !!d.online,
      players: Math.max(0, parseInt(d.player_count, 10) || 0),
    }))
  );
  return {
    servers,
    total: servers.reduce((n, d) => n + (d.online ? d.players : 0), 0),
    regions: rollup(servers),
  };
}

function rollup(servers) {
  const out = {};
  for (const d of servers) {
    const r = (out[d.region] ||= { code: d.region, servers: 0, online: 0, pop: 0 });
    r.servers += 1;
    if (d.online) { r.online += 1; r.pop += d.players; }
  }
  return out;
}

// ------------------------------ commands ---------------------------------

const handlers = {

  async status(_o, env) {
    const t = await readTracker(env);
    let data = t.latest, live = true;
    if (!data || !data.servers?.length) { data = await mothershipNow(env); live = false; }

    const online = (data.servers || []).filter((s) => s.online);
    const total = data.total ?? 0;
    const embed = baseEmbed(`Project Rebirth — ${fmt(total)} online`,
      live ? `Tracked by the watcher · updated ${ts(data.t || Date.now())}`
           : "⚠️ No cached data yet — polled the game API directly.");
    embed.fields = online.length
      ? [{ name: "Servers", value: clip(online.map((s) =>
          `${flag(s.region)} **${s.name}** · ${s.region} — ${fmt(s.players)} players` +
          (s.version ? ` · build ${s.version}` : "")).join("\n"), 1024) }]
      : [{ name: "Servers", value: "All servers offline." }];
    if (data.all_time_peak) {
      embed.footer = { text: `Tracked peak: ${fmt(data.all_time_peak)} · Project Rebirth Watcher` };
    }
    return { embeds: [embed] };
  },

  async region(o, env) {
    const continent = (o.continent || "NA").toUpperCase();
    const t = await readTracker(env);
    const regions = t.latest?.regions || {};
    const embed = baseEmbed(`Best region for ${continent}`);
    const list = Object.values(regions);
    if (!list.length) {
      embed.description = "No region data yet — waiting on the first cron tick.";
      return { embeds: [embed] };
    }
    const a = advise(regions, continent);
    embed.fields = [
      { name: "Recommendation", value: a.recommended
          ? `${flag(a.recommended)} **${a.recommended}** — ${a.reason}`
          : a.reason || "No data." },
      ...(a.options.length > 1
        ? [{
            name: "Ranked shortlist (geo + population + health)",
            value: clip(a.options.slice(0, 5).map((x, i) =>
              `**${i + 1}.** ${flag(x.code)} **${x.code}** — score ${x.score} · ${x.why}`
            ).join("\n"), 1024),
          }]
        : []),
      { name: "All regions", value: clip(list.sort((x, y) => y.pop - x.pop).map((r) =>
          `${flag(r.code)} **${r.code}** — ${r.online ? `🟢 ${fmt(r.pop)} players` : "🔴 offline"} (${r.servers})`
        ).join("\n"), 1024) },
    ];
    return { embeds: [embed] };
  },

  async peak(_o, env) {
    const t = await readTracker(env);
    const { by_day, best_hours: best, best_windows, weekend, weekday, samples } =
      peakAnalytics(t.peak || {});

    const embed = baseEmbed("Busiest hours (UTC)");
    if (!best.length) {
      embed.description = "Not enough samples yet — the matrix fills in over a few hours.";
      return { embeds: [embed] };
    }
    embed.description = `From ${fmt(samples)} samples · updated ${ts(t.prev?.t)}`;

    embed.fields = [
      { name: "Top hours by average players", value: best.map((c, i) =>
          `**${i + 1}.** ${DAYS[c.dow]} ${String(c.hour).padStart(2, "0")}:00 — avg ${fmt(c.avg)}, peak ${fmt(c.max)}`
        ).join("\n") },
      { name: "By day of week", value: by_day.length
          ? by_day.map((d) => `**${DAYS[d.dow]}** — avg ${fmt(d.avg)} · peak ${fmt(d.max)} · ${d.n} samples`)
              .join("\n")
          : "No data yet." },
    ];

    if (best_windows.length) {
      embed.fields.push({
        name: "Best 4-hour session windows",
        value: clip(best_windows
          .sort((a, b) => b.avg - a.avg)
          .slice(0, 5)
          .map((w) => `**${DAYS[w.dow]}** ${String(w.start).padStart(2, "0")}:00–${String(w.end + 1).padStart(2, "0")}:00 — avg ${fmt(w.avg)}`)
          .join("\n"), 1024),
      });
    }
    if (weekend.n && weekday.n) {
      const diff = weekend.avg - weekday.avg;
      embed.fields.push({
        name: "Weekend vs weekday",
        value: `Weekend avg **${fmt(weekend.avg)}** vs weekday **${fmt(weekday.avg)}** ` +
               `(${diff >= 0 ? "+" : ""}${fmt(diff)} players)`,
        inline: true,
      });
    }
    return { embeds: [embed] };
  },

  async patches(o, env) {
    const n = Math.min(20, Math.max(1, o.count ?? 5));
    const patches = await readJson(env, "patches", []);
    const t = await readTracker(env);
    const rollout = patchRollout(t.latest?.servers || []);
    const stats = patchStats(patches);

    const embed = baseEmbed("Update timeline");
    embed.fields = [];

    if (rollout.newest_build) {
      embed.fields.push({
        name: "Rollout",
        value:
          `Newest build **${rollout.newest_build}** · ` +
          (rollout.rollout_complete
            ? "every region is current"
            : `**${rollout.lagging.length} region(s) behind**: ${rollout.lagging.join(", ")}`) +
          `\n${Object.entries(rollout.regions).map(([c, b]) => `${flag(c)} ${c}: ${b}`).join(" · ")}`,
      });
    }

    const cadence = [
      stats.median_interval_h != null ? `median ${stats.median_interval_h}h between builds` : null,
      `${stats.last_7d} in the last 7d`,
      stats.builds_tracked ? `${stats.builds_tracked} distinct builds tracked` : null,
    ].filter(Boolean).join(" · ");
    if (cadence) embed.fields.push({ name: "Cadence", value: cadence, inline: true });

    embed.description = patches.length
      ? clip(patches.slice(0, n).map((p) => {
          const bits = [`**${clip(p.title.replace(/^Patch: /, ""), 120)}**`, p.body];
          const deployed = isoTs(p.created);
          if (deployed) bits.push(`new instance deployed ${deployed}`);
          if (p.since_prev_s) bits.push(`previous build ${dur(p.since_prev_s)} earlier`);
          return `${bits.join("\n")} · ${ts(p.t)}`;
        }).join("\n\n"), 4000)
      : "No build bumps observed yet — history starts from the first deploy.";
    return { embeds: [embed] };
  },

  async restarts(o, env) {
    const n = Math.min(20, Math.max(1, o.count ?? 5));
    const restarts = await readJson(env, "restarts", []);
    const events = await readJson(env, "events", []);
    const s = restartForensics(restarts, events);

    const embed = baseEmbed("Server restarts");
    if (!restarts.length) {
      embed.description = "No restarts observed yet.";
      return { embeds: [embed] };
    }

    embed.fields = [{
      name: "Forensics",
      value: [
        `${s.last_24h} in the last 24h · ${s.last_7d} in the last 7d`,
        `${s.restarts_per_day} per day`,
        `MTBF ${s.mtbf_h != null ? `${s.mtbf_h}h` : "—"}`,
        `avg downtime ${s.avg_downtime_s != null ? dur(s.avg_downtime_s) : "—"}` +
          (s.median_downtime_s != null ? ` (median ${dur(s.median_downtime_s)})` : ""),
      ].join(" · "),
      inline: false,
    }];

    const w = s.stale_warnings;
    if (w.fired) {
      embed.fields.push({
        name: "Early-warning accuracy",
        value: `**${w.fired}** stale-heartbeat alert${w.fired === 1 ? "" : "s"} fired → ` +
          `**${w.predicted}** preceded a real crash ` +
          `(${w.hit_rate != null ? Math.round(w.hit_rate * 100) : 0}%, ` +
          `${w.median_lead_s != null ? dur(w.median_lead_s) : "—"} of warning). ` +
          `${w.false_alarms} false alarm(s) in the ${Math.round(w.window_s / 60)}m window.`,
      });
    }

    if (s.by_day.length) {
      embed.fields.push({
        name: "Restarts by day",
        value: clip(s.by_day.slice(-7).map((d) => `${d.day.slice(5)}: **${d.n}**`).join(" · "), 1024),
        inline: true,
      });
    }

    embed.description = clip(restarts.slice(0, n).map((r) =>
      `**${clip(r.title.replace(/^Server restarted: /, ""), 120)}**\n${r.body} · ${ts(r.t)}`
    ).join("\n\n"), 4000);
    return { embeds: [embed] };
  },

  async config(o, env) {
    const n = Math.min(20, Math.max(1, o.count ?? 5));
    const changes = await readJson(env, "configlog", []);
    const t = await readTracker(env);
    const roster = t.prev?.roster || {};
    const whitelist = changes.filter((c) => c.signal === "whitelist");
    const rosterKeys = Object.keys(roster);

    const embed = baseEmbed(whitelist.length ? "Config & roster changes" : "Config changes");
    embed.fields = [];

    if (rosterKeys.length) {
      embed.fields.push({
        name: "Live roster (who's playing)",
        value: clip(rosterKeys.slice(0, 6).map((k) => {
          const [where, path] = k.split(":");
          const names = roster[k] || [];
          return `**${where}** — ${names.length ? names.join(", ") : "empty"}` +
            (path ? `  \`${path.split("/").pop()}\`` : "");
        }).join("\n"), 1024),
      });
    }

    if (whitelist.length) {
      embed.fields.push({
        name: "Recent roster movement",
        value: clip(whitelist.slice(0, 5).map((c) => {
          const bits = [];
          if (c.added && c.added.length) bits.push(`**+${c.added.join(", ")}**`);
          if (c.removed && c.removed.length) bits.push(`**−${c.removed.join(", ")}**`);
          return `**${clip(c.title.replace(/^(Whitelist|Config) changed: /, ""), 80)}** ` +
            `${bits.length ? bits.join(" ") : "roster edited, same names"} · ${ts(c.t)}`;
        }).join("\n"), 1024),
      });
    }

    embed.description = changes.length
      ? clip(changes.slice(0, n).map((c) => {
          const diff = (c.fields || []).map((f) => `· \`${clip(f.name, 80)}\`: ${clip(f.value, 120)}`).join("\n");
          return `**${clip(c.title.replace(/^(Whitelist|Config) changed: /, ""), 120)}** · ${ts(c.t)}\n${c.body}${diff ? `\n${diff}` : ""}`;
        }).join("\n\n"), 4000)
      : "No config drift observed yet.";
    return { embeds: [embed] };
  },

  async events(o, env) {
    const n = Math.min(25, Math.max(1, o.count ?? 10));
    const events = await readJson(env, "events", []);
    const ICONS = {
      server_up: "🟢", server_down: "🔴", stale: "🟡", recovered: "🔵",
      milestone: "📈", global_milestone: "📈", peak_record: "🏆",
      patch: "🧩", restart: "🔄", config: "🔧", region_death: "💀", region_rebirth: "✨",
    };
    const embed = baseEmbed("Watcher event feed");
    embed.description = events.length
      ? clip(events.slice(0, n).map((e) => `${ICONS[e.type] || "•"} ${e.title} · ${ts(e.t)}`).join("\n"), 4000)
      : "No events yet.";
    return { embeds: [embed] };
  },

  async history(o, env) {
    const ms = { "24h": 864e5, "7d": 6048e5, "30d": 2592e6 }[o.range || "24h"] || 864e5;
    const { samples } = await readTracker(env);
    const win = (samples || []).filter((s) => s.t >= Date.now() - ms);
    const embed = baseEmbed(`Concurrency — last ${o.range || "24h"}`);
    if (win.length < 2) {
      embed.description = "Not enough samples in this window yet.";
      return { embeds: [embed] };
    }
    const vals = win.map((s) => s.v);
    const avg = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    let best3 = { avg: -1, t: win[0].t };
    for (let i = 0; i + 6 <= win.length; i += 3) {
      const chunk = win.slice(i, i + 6);
      const a = chunk.reduce((n, s) => n + s.v, 0) / chunk.length;
      if (a > best3.avg) best3 = { avg: a, t: chunk[0].t };
    }
    embed.fields = [
      { name: "Now", value: fmt(vals[vals.length - 1]), inline: true },
      { name: "Average", value: fmt(avg), inline: true },
      { name: "Peak", value: fmt(Math.max(...vals)), inline: true },
      { name: "Low", value: fmt(Math.min(...vals)), inline: true },
      { name: "Samples", value: fmt(win.length), inline: true },
      { name: "Busiest 3h", value: `${fmt(Math.round(best3.avg))} avg · from ${ts(best3.t)}`, inline: true },
    ];
    return { embeds: [embed] };
  },
};

// ------------------------------ entry point ------------------------------

/**
 * @param body   parsed interaction JSON (already signature-verified)
 * @param env    worker env (HISTORY KV binding)
 * @returns      JSON body to return to Discord
 */
export async function handleInteraction(body, env) {
  // 1 = PING (handshake), 2 = APPLICATION_COMMAND
  if (body.type === 1) return { type: 1 };
  if (body.type !== 2 || body.data?.name !== "pr") {
    return { type: 4, data: { content: "Unknown command.", allowed_mentions: { parse: [] } } };
  }

  const sub = body.data.options?.[0]?.name || "status";
  const opts = Object.fromEntries(
    (body.data.options?.[0]?.options || []).map((x) => [x.name, x.value])
  );
  const handler = handlers[sub];
  if (!handler) {
    return { type: 4, data: { content: `Unknown subcommand \`${sub}\`.`, allowed_mentions: { parse: [] } } };
  }

  try {
    const payload = await handler(opts, env);
    return { type: 4, data: { ...payload, allowed_mentions: { parse: [] } } };
  } catch (err) {
    console.log(`interaction /${sub} failed:`, err.message);
    return {
      type: 4,
      data: {
        content: "⚠️ That query failed — the watcher may still be warming up. Try again in a minute.",
        allowed_mentions: { parse: [] },
      },
    };
  }
}

// ------------------------------ verification -----------------------------

function hexToBytes(hex) {
  if (!hex || hex.length % 2) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.substr(i * 2, 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
}

/**
 * Verify Discord's Ed25519 request signature.
 * Signed message = timestamp header + raw body.
 */
export async function verifyInteraction(publicKeyHex, rawBody, sigHex, timestamp) {
  if (!publicKeyHex || !sigHex || !timestamp) return false;
  const pub = hexToBytes(publicKeyHex.trim());
  const sig = hexToBytes(sigHex.trim());
  if (!pub || !sig) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw", pub, { name: "Ed25519" }, false, ["verify"]
    );
    const msg = new TextEncoder().encode(timestamp + rawBody);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sig, msg);
  } catch (err) {
    console.log("verify error:", err.message);
    return false;
  }
}
