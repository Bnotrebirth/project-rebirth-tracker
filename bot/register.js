/* =========================================================================
   Registers the /pr command group without starting the bot.

   Usage:
     node register.js              # guild-scoped (instant) if GUILD_ID set
     node register.js --global     # force global registration (~1h to appear)

   Same config sources as index.js: bot/config.json or environment vars.
   ========================================================================= */

import { REST, Routes } from "discord.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commands } from "./commands.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let fileCfg = {};
try {
  fileCfg = JSON.parse(fs.readFileSync(path.join(HERE, "config.json"), "utf8"));
} catch { /* env-only is fine */ }
const envCfg = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => ["DISCORD_TOKEN", "CLIENT_ID", "GUILD_ID"].includes(k))
);
const cfg = { ...fileCfg, ...envCfg };

if (!cfg.DISCORD_TOKEN || !cfg.CLIENT_ID) {
  console.error("missing DISCORD_TOKEN / CLIENT_ID — set them in bot/config.json or the environment");
  process.exit(1);
}

const forceGlobal = process.argv.includes("--global");

const rest = new REST().setToken(cfg.DISCORD_TOKEN);
const useGuild = !forceGlobal && cfg.GUILD_ID;
const route = useGuild
  ? Routes.applicationGuildCommands(cfg.CLIENT_ID, cfg.GUILD_ID)
  : Routes.applicationCommands(cfg.CLIENT_ID);

const result = await rest.put(route, { body: commands });
console.log(`registered ${result.length} commands ${useGuild ? `in guild ${cfg.GUILD_ID} (instant)` : "globally (may take up to an hour)"}`);
