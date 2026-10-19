/* Shared /pr command definition — imported by both index.js (registers on
   startup) and register.js (standalone re-registration). Keep in sync with
   the handler names in index.js. */

import { SlashCommandBuilder } from "discord.js";

export const commands = [
  new SlashCommandBuilder()
    .setName("pr")
    .setDescription("Project Rebirth server intelligence")
    .addSubcommand((s) => s.setName("status").setDescription("Live server status and player counts"))
    .addSubcommand((s) => s.setName("region")
      .setDescription("Which region should I play in?")
      .addStringOption((o) => o.setName("continent")
        .setDescription("Your continent (default: NA)")
        .setRequired(false)
        .addChoices(
          { name: "North America", value: "NA" },
          { name: "Europe", value: "EU" },
          { name: "Oceania", value: "OC" },
          { name: "South America", value: "SA" },
          { name: "Asia", value: "AS" },
        )))
    .addSubcommand((s) => s.setName("peak")
      .setDescription("Busiest hours to play")
      .addIntegerOption((o) => o.setName("days").setDescription("Sample window (default 7)")
        .setRequired(false).setMinValue(1).setMaxValue(30)))
    .addSubcommand((s) => s.setName("patches")
      .setDescription("Recent game build bumps")
      .addIntegerOption((o) => o.setName("count").setDescription("How many (default 5)")
        .setRequired(false).setMinValue(1).setMaxValue(20)))
    .addSubcommand((s) => s.setName("restarts")
      .setDescription("Server restart forensics")
      .addIntegerOption((o) => o.setName("count").setDescription("How many (default 5)")
        .setRequired(false).setMinValue(1).setMaxValue(20)))
    .addSubcommand((s) => s.setName("config")
      .setDescription("Recent server config changes (whitelists, modules)")
      .addIntegerOption((o) => o.setName("count").setDescription("How many (default 5)")
        .setRequired(false).setMinValue(1).setMaxValue(20)))
    .addSubcommand((s) => s.setName("events")
      .setDescription("Raw watcher event feed")
      .addIntegerOption((o) => o.setName("count").setDescription("How many (default 10)")
        .setRequired(false).setMinValue(1).setMaxValue(25)))
    .addSubcommand((s) => s.setName("history")
      .setDescription("Concurrency summary from the tracked history")
      .addStringOption((o) => o.setName("range")
        .setDescription("Window (default 24h)")
        .setRequired(false)
        .addChoices(
          { name: "24 hours", value: "24h" },
          { name: "7 days", value: "7d" },
          { name: "30 days", value: "30d" },
        ))),
].map((c) => c.toJSON());
