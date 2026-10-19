/* =========================================================================
   Project Rebirth — Discord bot (slash commands)

   Interactive companion to the watcher worker. The worker already pushes
   alerts (up/down, milestones, patches...) to a webhook; this bot answers
   on-demand questions inside "Project Rebirth test":

     /pr status              live totals + per-server breakdown
     /pr region [continent]  best-region advisor for NA/EU/OCE/...
     /pr peak [days]         busiest hours (from the worker's matrix)
     /pr patches [n]         recent build bumps
     /pr restarts [n]        restart forensics + downtime stats
     /pr config [n]          config drift log (whitelists, module settings)
     /pr events [n]          raw watcher event feed
     /pr history [range]     concurrency summary from the chart data

   Config (env vars or bot/config.json — env wins):
     DISCORD_TOKEN   bot token
     CLIENT_ID       application (client) id
     GUILD_ID        server id — registers commands instantly for testing
     WORKER_URL      base URL of the deployed worker
                     (default: the local wrangler dev URL)
   ========================================================================= */

import {
  Client, GatewayIntentBits, REST, Routes,
  EmbedBuilder,
} from "discord.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commands } from "./commands.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ------------------------------ config -----------------------------------

function loadConfig() {
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(path.join(HERE, "config.json"), "utf8"));
  } catch { /* env-only config is fine */ }
  const cfg = { ...fileCfg, ...Object.fromEntries(
    Object.entries(process.env).filter(([k]) => [
      "DISCORD_TOKEN", "CLIENT_ID", "GUILD_ID", "WORKER_URL",
    ].includes(k))
  ) };
  cfg.WORKER_URL ||= "http://localhost:8787";
  return cfg;
}

const cfg = loadConfig();
for (const key of ["DISCORD_TOKEN", "CLIENT_ID"]) {
  if (!cfg[key]) {
    console.error(`missing ${key} — set it in bot/config.json or the environment`);
    process.exit(1);
  }
}

// ------------------------------ data layer --------------------------------

const API = cfg.WORKER_URL.replace(/\/$/, "");

async function workerGet(pathname) {
  const res = await fetch(`${API}${pathname}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`worker ${pathname} returned HTTP ${res.status}`);
  return res.json();
}

/**
 * Last-resort live fetch, used only when the worker itself is down. The
 * endpoint is configuration (GAME_API_URL in the environment, or GAME_API_URL
 * in bot/config.json) and is deliberately not stored anywhere in this repo.
 * Returns null when it isn't configured so the command degrades instead of
 * crashing.
 */
async function mothershipStatus() {
  const url = String(process.env.GAME_API_URL || cfg.GAME_API_URL || "").trim();
  if (!url) return null;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`game API HTTP ${res.status}`);
  const json = await res.json();
  const servers = (json.items || []).flatMap((s) => s.deployments || []);
  return {
    total: servers.reduce((n, d) => n + (d.online ? Number(d.player_count) || 0 : 0), 0),
    servers: servers.map((d) => ({
      name: d.deployment_name, region: d.region, ip: d.ip,
      online: !!d.online, players: Number(d.player_count) || 0,
      version: String(d.version ?? ""),
    })),
  };
}

// ------------------------------ formatting --------------------------------

const CYAN = 0x00ffe1;
const fmt = (n) => new Intl.NumberFormat().format(n);

function ts(epochMs) {
  return epochMs ? `<t:${Math.floor(epochMs / 1000)}:R>` : "never";
}

function dur(sec) {
  if (!Number.isFinite(sec)) return "?";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${sec % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const REGION_FLAGS = { NAE: "🇺🇸", NAW: "🇺🇸", EU: "🇪🇺", OCE: "🇦🇺", SAC: "🇧🇷", ASIA: "🌏" };
const flag = (r) => REGION_FLAGS[String(r || "").toUpperCase()] || "🌐";

function baseEmbed(title) {
  return new EmbedBuilder().setColor(CYAN).setTitle(title)
    .setFooter({ text: "Project Rebirth Watcher" }).setTimestamp();
}

function safe(fn, errMsg) {
  try {
    const out = fn();
    return out instanceof Promise ? out : Promise.resolve(out);
  } catch (err) {
    return Promise.reject(new Error(errMsg || err.message));
  }
}

// ------------------------------ commands ----------------------------------
// The /pr command tree lives in commands.js (shared with register.js).

// ------------------------------ handlers ----------------------------------

const handlers = {
  async status() {
    let data = null, live = true;
    try {
      data = await workerGet("/api/state");
    } catch {
      data = await mothershipStatus(); // null when the endpoint isn't configured
      live = false;
    }
    const servers = data?.servers || [];
    const online = servers.filter((s) => s.online);
    const total = data?.total_online ?? data?.total ?? 0;
    const embed = baseEmbed(`Project Rebirth — ${fmt(total)} online`)
      .setDescription(live
        ? `Tracked by the watcher · data ${ts(data?.generated_at)}`
        : "⚠️ Worker unreachable — no cached snapshot to fall back on");
    if (online.length) {
      embed.addFields({
        name: "Servers",
        value: online.map((s) =>
          `${flag(s.region)} **${s.name}** · ${s.region} — ${fmt(s.players)} players` +
          (s.version ? ` · build ${s.version}` : "")
        ).join("\n").slice(0, 1024),
      });
    } else {
      embed.addFields({ name: "Servers", value: "All servers offline." });
    }
    if (data.all_time_peak) {
      embed.setFooter({ text: `All-time tracked peak: ${fmt(data.all_time_peak)} · Project Rebirth Watcher` });
    }
    return { embeds: [embed] };
  },

  async region(opts) {
    const continent = opts.getString("continent") || "NA";
    const data = await workerGet(`/api/state?continent=${continent}`);
    const a = data.advice;
    const regions = Object.values(data.regions || {});
    const embed = baseEmbed(`Best region for ${continent}`);
    if (!regions.length) {
      embed.setDescription("No region data yet — the watcher needs one cron tick first.");
      return { embeds: [embed] };
    }
    embed.addFields({
      name: "Recommendation",
      value: a.recommended
        ? `${flag(a.recommended)} **${a.recommended}** — ${a.reason}`
        : a.reason || "No data.",
    }).addFields({
      name: "All regions",
      value: regions.sort((x, y) => y.pop - x.pop).map((r) =>
        `${flag(r.code)} **${r.code}** — ${r.online ? `🟢 ${fmt(r.pop)} players` : "🔴 offline"} (${r.servers} server${r.servers === 1 ? "" : "s"})`
      ).join("\n").slice(0, 1024),
    });
    return { embeds: [embed] };
  },

  async peak(opts) {
    const { cells, best_hours: best, generated_at: gen } = await workerGet("/api/peak");
    const embed = baseEmbed("Busiest hours (UTC)");
    if (!best || !best.length) {
      embed.setDescription("Not enough samples yet — the matrix fills in over a few hours.");
      return { embeds: [embed] };
    }
    const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    embed.addFields({
      name: "Top hours by average players",
      value: best.map((c, i) =>
        `**${i + 1}.** ${DAYS[c.dow]} ${String(c.hour).padStart(2, "0")}:00 — avg ${fmt(c.avg)}, peak ${fmt(c.max)}`
      ).join("\n"),
    }).setDescription(`Built from ${fmt(cells.reduce((n, c) => n + c.n, 0))} samples · updated ${ts(gen)}`);
    return { embeds: [embed] };
  },

  async patches(opts) {
    const n = opts.getInteger("count") ?? 5;
    const { patches } = await workerGet(`/api/patches?limit=${n}`);
    const embed = baseEmbed("Recent patches");
    if (!patches.length) {
      embed.setDescription("No build bumps observed yet. The watcher only knows history from its first deploy.");
      return { embeds: [embed] };
    }
    embed.setDescription(patches.map((p) =>
      `**${p.title.replace(/^Patch: /, "")}**\n${p.body} · ${ts(p.t)}`
    ).join("\n\n").slice(0, 4000));
    return { embeds: [embed] };
  },

  async restarts(opts) {
    const n = opts.getInteger("count") ?? 5;
    const { restarts, stats } = await workerGet(`/api/restarts?limit=${n}`);
    const embed = baseEmbed("Server restarts");
    if (!restarts.length) {
      embed.setDescription("No restarts observed yet.");
      return { embeds: [embed] };
    }
    embed.addFields({
      name: "Stats (24h)",
      value: `${stats.last_24h} restart(s) · avg downtime ${dur(stats.avg_downtime_s)}` +
        (stats.mtbf_h ? ` · MTBF ~${stats.mtbf_h}h` : ""),
    }).setDescription(restarts.slice(0, 8).map((r) =>
      `**${r.title.replace(/^Server restarted: /, "")}**\n${r.body} · ${ts(r.t)}`
    ).join("\n\n").slice(0, 4000));
    return { embeds: [embed] };
  },

  async config(opts) {
    const n = opts.getInteger("count") ?? 5;
    const { changes } = await workerGet(`/api/config?limit=${n}`);
    const embed = baseEmbed("Config changes");
    if (!changes.length) {
      embed.setDescription("No config drift observed yet.");
      return { embeds: [embed] };
    }
    embed.setDescription(changes.map((c) => {
      const diff = (c.fields || []).map((f) => `· \`${f.name}\`: ${f.value}`).join("\n");
      return `**${c.title.replace(/^Config changed: /, "")}** · ${ts(c.t)}\n${c.body}${diff ? `\n${diff}` : ""}`;
    }).join("\n\n").slice(0, 4000));
    return { embeds: [embed] };
  },

  async events(opts) {
    const n = opts.getInteger("count") ?? 10;
    const { events } = await workerGet(`/api/events?limit=${n}`);
    const ICONS = {
      server_up: "🟢", server_down: "🔴", stale: "🟡", recovered: "🔵",
      milestone: "📈", global_milestone: "📈", peak_record: "🏆",
      patch: "🧩", restart: "🔄", config: "🔧", region_death: "💀", region_rebirth: "✨",
    };
    const embed = baseEmbed("Watcher event feed");
    embed.setDescription(events.length
      ? events.map((e) => `${ICONS[e.type] || "•"} ${e.title} · ${ts(e.t)}`).join("\n").slice(0, 4000)
      : "No events yet.");
    return { embeds: [embed] };
  },

  async history(opts) {
    const range = opts.getString("range") || "24h";
    const ms = { "24h": 864e5, "7d": 6048e5, "30d": 2592e6 }[range];
    const { samples } = await workerGet("/history.json");
    const cutoff = Date.now() - ms;
    const win = (samples || []).filter((s) => s.t >= cutoff);
    const embed = baseEmbed(`Concurrency — last ${range}`);
    if (win.length < 2) {
      embed.setDescription("Not enough samples in this window yet.");
      return { embeds: [embed] };
    }
    const vals = win.map((s) => s.v);
    const avg = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    const max = Math.max(...vals);
    const min = Math.min(...vals);
    const latest = vals[vals.length - 1];
    // busiest 3h block
    let best3 = { avg: -1, label: "" };
    for (let i = 0; i + 6 <= win.length; i += 3) {        // step 6 samples = 12 min
      const chunk = win.slice(i, i + 6);
      const a = chunk.reduce((n, s) => n + s.v, 0) / chunk.length;
      if (a > best3.avg) {
        best3 = { avg: a, label: new Date(chunk[0].t).toISOString() };
      }
    }
    embed.addFields(
      { name: "Now", value: fmt(latest), inline: true },
      { name: "Average", value: fmt(avg), inline: true },
      { name: "Peak", value: fmt(max), inline: true },
      { name: "Low", value: fmt(min), inline: true },
      { name: "Samples", value: fmt(win.length), inline: true },
      { name: "Busiest 3h", value: `${fmt(Math.round(best3.avg))} avg · from ${best3.label.slice(11, 16)} UTC`, inline: true },
    );
    return { embeds: [embed] };
  },
};

// ------------------------------ wiring ------------------------------------

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "pr") return;
  const sub = interaction.options.getSubcommand();
  const handler = handlers[sub];
  if (!handler) return interaction.reply({ content: `Unknown subcommand \`${sub}\`.`, ephemeral: true });

  await interaction.deferReply();
  try {
    const payload = await safe(() => handler(interaction.options));
    await interaction.editReply(payload);
  } catch (err) {
    console.error(`/${sub} failed:`, err);
    await interaction.editReply({
      content: "⚠️ That query failed — is the worker deployed and has it ticked at least once?",
    }).catch(() => {});
  }
});

client.once("clientReady", () => console.log(`bot online as ${client.user.tag} · api ${API}`));

async function main() {
  // Register the /pr command (guild-scoped = instant; global if no GUILD_ID).
  const rest = new REST().setToken(cfg.DISCORD_TOKEN);
  const route = cfg.GUILD_ID
    ? Routes.applicationGuildCommands(cfg.CLIENT_ID, cfg.GUILD_ID)
    : Routes.applicationCommands(cfg.CLIENT_ID);
  await rest.put(route, { body: commands });
  console.log(`registered ${commands.length} command group ${cfg.GUILD_ID ? `in guild ${cfg.GUILD_ID}` : "globally"}`);
  await client.login(cfg.DISCORD_TOKEN);
}

main().catch((err) => { console.error(err); process.exit(1); });
