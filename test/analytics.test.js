/* =========================================================================
   Tests for the five analytics features — run with:  npm test

   1. patch detector   → build diffs, per-deployment cadence, rollout state
   2. restart forensics→ MTBF, restarts/day, stale-heartbeat warning accuracy
   3. config drift     → whitelist roster extraction + join/leave signal
   4. peak hours       → day-of-week / hour-of-day rollups, weekend vs weekday
   5. region advisor   → scored shortlist from population + geo continent
   ========================================================================= */

import test from "node:test";
import assert from "node:assert/strict";
import {
  tick, advise, parseRoster, rosterDelta, buildRoster, isRosterKey, WHITELIST_KEY_RE,
  fmt as fmtNum,
} from "../core.js";
import {
  restartForensics, patchRollout, patchStats, peakAnalytics,
} from "../worker.js";

const T0 = Date.parse("2026-10-18T12:00:00Z");
const MIN = 60_000;
const HOUR = 3600e3;
const DAY = 24 * HOUR;

/** Compact server-browser payload builder (mirrors core.test.js). */
function payload(deps, at = T0, stationCfg = null) {
  return [{
    station_id: "station-1",
    station_name: "Communities",
    config: stationCfg,
    deployments: deps.map((d) => ({
      deployment_id: d.id,
      deployment_name: d.name || "Communities",
      region: d.region || "NAE",
      ip: d.ip || "45.8.201.127:7777",
      version: d.version || "22284",
      online: d.online ?? true,
      player_count: d.players ?? 0,
      created: d.created || "2026-10-17T21:04:10.046-04:00",
      last_event: d.last_event || new Date(at - (d.agoMin ?? 0) * MIN).toISOString(),
      config: d.config || {},
    })),
  }];
}
const dep = (over = {}) => ({ id: "dep-1", ...over });

// ==========================================================================
// Feature 1 — patch detector
// ==========================================================================

test("patch event carries a structured update-timeline record", () => {
  let { prev } = tick(null, payload([dep({ version: "22284", players: 20 })]), T0);
  const r = tick(prev, payload([dep({ version: "22285", players: 1 })], T0 + 5 * MIN), T0 + 5 * MIN);

  const ev = r.events.find((e) => e.type === "patch");
  assert.ok(ev, "expected a patch event");
  assert.equal(ev.version_from, "22284");
  assert.equal(ev.version_to, "22285");
  assert.equal(ev.region, "NAE");
  assert.equal(ev.dep, "dep-1");
  assert.ok(ev.created, "new instance created timestamp must be recorded");
  assert.ok(Number.isFinite(ev.downtime_s) || ev.downtime_s === null);
  assert.equal(ev.since_prev_s, null, "first observed patch has no predecessor");
});

test("patch cadence: since_prev_s measures the gap to the previous bump", () => {
  let { prev } = tick(null, payload([dep({ version: "22284" })]), T0);
  let r = tick(prev, payload([dep({ version: "22285" })], T0 + 6 * HOUR), T0 + 6 * HOUR);
  r = tick(r.prev, payload([dep({ version: "22286" })], T0 + 30 * HOUR), T0 + 30 * HOUR);

  const ev = r.events.find((e) => e.type === "patch");
  assert.equal(ev.version_from, "22285");
  assert.equal(ev.version_to, "22286");
  assert.equal(ev.since_prev_s, 24 * 3600, "24h between the two bumps");
  // and the clock persists on the deployment state
  assert.equal(r.prev.deps["dep-1"].patch_t, T0 + 30 * HOUR);
});

test("patchRollout detects newest build and laggard regions", () => {
  const servers = [
    { region: "NAE", version: "22285" },
    { region: "NAE", version: "22284" },   // mixed mid-rollout
    { region: "EU", version: "22284" },
    { region: "OCE", version: "" },         // no build reported → ignored
    { region: "ASIA" },                     // no version field → ignored
  ];
  const out = patchRollout(servers);

  assert.equal(out.newest_build, "22285");
  assert.deepEqual(out.builds_seen, ["22285", "22284"]);
  assert.deepEqual(out.regions, { NAE: "22285", EU: "22284" });
  assert.deepEqual(out.lagging, ["EU"], "EU hasn't picked up the new build");
  assert.equal(out.rollout_complete, false);
});

test("patchRollout reports completion once every region matches", () => {
  const out = patchRollout([
    { region: "NAE", version: "22285" },
    { region: "EU", version: "22285" },
  ]);
  assert.equal(out.rollout_complete, true);
  assert.deepEqual(out.lagging, []);
});

test("patchRollout tolerates an empty server list", () => {
  const out = patchRollout([]);
  assert.equal(out.newest_build, null);
  assert.deepEqual(out.builds_seen, []);
  assert.deepEqual(out.lagging, []);
  assert.equal(out.rollout_complete, false);
});

test("patchStats counts windows and derives median release interval", () => {
  const patches = [
    { t: T0 - 12 * HOUR, version_to: "22285", since_prev_s: 3600 },
    { t: T0 - 4 * DAY, version_to: "22284", since_prev_s: 7200 },
    { t: T0 - 10 * DAY, version_to: "22284" },  // no predecessor → excluded
  ];
  const s = patchStats(patches, T0);
  assert.equal(s.total, 3);
  assert.equal(s.last_24h, 1);
  assert.equal(s.last_7d, 2);
  assert.equal(s.last_patch_at, T0 - 12 * HOUR);
  assert.equal(s.median_interval_h, 1.5, "median of 1h and 2h");
  assert.equal(s.builds_tracked, 2);
});

test("patchRollout prefers numeric ordering over lexicographic", () => {
  // "999" > "1000" lexicographically, but not numerically
  const out = patchRollout([
    { region: "NAE", version: "1000" },
    { region: "EU", version: "999" },
  ]);
  assert.equal(out.newest_build, "1000");
  assert.deepEqual(out.lagging, ["EU"]);
});

// ==========================================================================
// Feature 2 — crash / restart forensics
// ==========================================================================

test("restart forensics: real MTBF from gaps, not 24h count ÷ 24", () => {
  const restarts = [
    { t: T0 - 3 * DAY, downtime_s: 120 },
    { t: T0 - 2 * DAY, downtime_s: 300 },
    { t: T0 - 6 * HOUR, downtime_s: 60 },
  ];
  const s = restartForensics(restarts, [], T0);

  assert.equal(s.total, 3);
  assert.equal(s.last_24h, 1);
  assert.equal(s.avg_downtime_s, 160, "(120+300+60)/3");
  assert.equal(s.median_downtime_s, 120);
  // gaps: 24h, then 42h (2d − 6h) → mean 33h
  assert.equal(s.mtbf_h, 33);
  assert.equal(s.restarts_per_day, 1, "3 restarts across 3 distinct days");
  assert.deepEqual(s.by_day.map((d) => d.day), ["2026-10-15", "2026-10-16", "2026-10-18"]);
  assert.ok(s.by_day.every((d) => d.n === 1));
});

test("restart forensics handles an empty log without NaN", () => {
  const s = restartForensics([], [], T0);
  assert.equal(s.total, 0);
  assert.equal(s.avg_downtime_s, null);
  assert.equal(s.median_downtime_s, null);
  assert.equal(s.mtbf_h, null);
  assert.equal(s.restarts_per_day, 0);
  assert.deepEqual(s.by_day, []);
  assert.equal(s.stale_warnings.hit_rate, null);
  assert.equal(s.stale_warnings.fired, 0);
});

test("restarts in the last 24h are bucketed into a single day", () => {
  const restarts = [
    { t: T0 - 2 * HOUR, downtime_s: 90 },
    { t: T0 - 5 * HOUR, downtime_s: 90 },
  ];
  const s = restartForensics(restarts, [], T0);
  assert.equal(s.last_24h, 2);
  assert.deepEqual(s.by_day, [{ day: "2026-10-18", n: 2 }]);
});

test("stale heartbeat warnings are scored against what actually happened", () => {
  const events = [
    // dep-1: warned, then crashed 5 minutes later → hit
    { t: T0 - 10 * MIN, type: "stale", dep: "dep-1" },
    { t: T0 - 5 * MIN, type: "restart", dep: "dep-1" },
    // dep-2: warned, server carried on → false alarm
    { t: T0 - 8 * MIN, type: "stale", dep: "dep-2" },
    // dep-3: warned, crashed 59 minutes later → outside the 30m window
    { t: T0 - 60 * MIN, type: "stale", dep: "dep-3" },
    { t: T0 - 1 * MIN, type: "server_down", dep: "dep-3" },
  ];
  const s = restartForensics([], events, T0);
  const w = s.stale_warnings;

  assert.equal(w.fired, 3);
  assert.equal(w.predicted, 1);
  assert.equal(w.false_alarms, 2);
  assert.equal(w.hit_rate, 0.33, "1 of 3 warnings came true");
  assert.equal(w.median_lead_s, 300, "5 minutes of warning before the crash");
  assert.equal(w.window_s, 30 * 60);
});

test("a stale warning must not credit a crash belonging to another server", () => {
  const events = [
    { t: T0 - 10 * MIN, type: "stale", dep: "dep-1" },
    { t: T0 - 4 * MIN, type: "restart", dep: "dep-other" },  // wrong deployment
  ];
  const w = restartForensics([], events, T0).stale_warnings;
  assert.equal(w.predicted, 0);
  assert.equal(w.false_alarms, 1);
});

test("events without a deployment id can't skew the warning score", () => {
  const events = [
    { t: T0 - 10 * MIN, type: "stale" },          // no dep → not scored
    { t: T0 - 9 * MIN, type: "restart", dep: "x" },
  ];
  const w = restartForensics([], events, T0).stale_warnings;
  assert.equal(w.fired, 0);
  assert.equal(w.hit_rate, null);
});

test("restart event records the instance that died and the one that replaced it", () => {
  let { prev } = tick(null, payload([dep({ players: 60 })]), T0);
  let r = tick(prev, payload([dep({ online: false })], T0 + 2 * MIN), T0 + 2 * MIN);
  r = tick(r.prev, payload([dep({ players: 3, created: "2026-10-18T08:00:00Z" })], T0 + 10 * MIN), T0 + 10 * MIN);

  const ev = r.events.find((e) => e.type === "restart");
  assert.ok(ev, "expected restart event");
  assert.equal(ev.dep, "dep-1");
  assert.equal(ev.region, "NAE");
  assert.equal(ev.created_to, "2026-10-18T08:00:00Z");
  assert.ok(ev.created_from, "the replaced instance must be recorded");
  assert.equal(ev.players_before, 60);
  assert.equal(ev.downtime_s, 8 * 60, "offline from +2m to +10m");
});

// ==========================================================================
// Feature 3 — config drift / whitelist pre-announcement
// ==========================================================================

test("parseRoster splits, trims and de-duplicates names", () => {
  assert.deepEqual(parseRoster("gr3my, dizzy, Bnot,"), ["gr3my", "dizzy", "Bnot"]);
  assert.deepEqual(parseRoster('"gr3my, dizzy,"'), ["gr3my", "dizzy"],
    "values arrive JSON-quoted from flattenCfg");
  assert.deepEqual(parseRoster("Gr3my, gr3my, dizzy"), ["Gr3my", "dizzy"],
    "case-insensitive dedupe keeps the first spelling");
  assert.deepEqual(parseRoster(""), []);
  assert.deepEqual(parseRoster(null), []);
  assert.deepEqual(parseRoster(["a", " b "]), ["a", "b"]);
});

test("rosterDelta reports joins and leaves, case-insensitively", () => {
  assert.deepEqual(rosterDelta("a, b", "b, c"), { added: ["c"], removed: ["a"] });
  assert.deepEqual(rosterDelta("Gr3my", "gr3my"), { added: [], removed: [] },
    "renaming case isn't a roster change");
  assert.deepEqual(rosterDelta("a, b", ""), { added: [], removed: ["a", "b"] });
  assert.deepEqual(rosterDelta("", "a"), { added: ["a"], removed: [] });
});

test("whitelist detection separates real rosters from toggle settings", () => {
  assert.ok(WHITELIST_KEY_RE.test("nv.module.TKB_Prime/Team0Whitelist"));
  assert.ok(!WHITELIST_KEY_RE.test("MaxPlayers"));

  // key matches AND the value is a name list → roster
  assert.ok(isRosterKey("nv.module.TKB_Prime/Team0Whitelist", "gr3my, dizzy,", "gr3my, dizzy, Bnot,"));
  assert.ok(isRosterKey("Team1Whitelist", null, "gr3my"), "a list being added counts");
  assert.ok(isRosterKey("Team2Whitelist", "gr3my", null), "a list being deleted counts");

  // key mentions whitelist but the value is not a list of people → not a roster
  assert.ok(!isRosterKey("bUseWhitelist", "true", "false"));
  assert.ok(!isRosterKey("WhitelistCount", "16", "32"));
  assert.ok(!isRosterKey("MaxPlayers", "16", "32"));
});

test("a whitelist toggle flip can't fabricate a player join", () => {
  const cfgA = { "nv.module.TKB_Prime": { bUseWhitelist: "false", Team0Whitelist: "gr3my" } };
  const cfgB = { "nv.module.TKB_Prime": { bUseWhitelist: "true", Team0Whitelist: "gr3my, dizzy" } };

  let { prev } = tick(null, payload([dep({ config: cfgA })]), T0);
  const r = tick(prev, payload([dep({ config: cfgB })], T0 + 2 * MIN), T0 + 2 * MIN);

  const ev = r.events.find((e) => e.type === "config");
  assert.ok(ev, "still flagged — a real roster change happened");
  assert.deepEqual(ev.added, ["dizzy"], "only the roster edit is reported");
  assert.deepEqual(ev.removed, []);
  assert.ok(!ev.added.includes("true"), "the boolean must never read as a name");
});

test("a whitelist edit is flagged as a signal with the roster delta", () => {
  const cfgA = { "nv.module.TKB_Prime": { bUseWhitelist: "true", Team0Whitelist: "gr3my, dizzy," } };
  const cfgB = { "nv.module.TKB_Prime": { bUseWhitelist: "true", Team0Whitelist: "gr3my, dizzy, Bnot," } };

  let { prev } = tick(null, payload([dep({ config: cfgA })]), T0);
  const r = tick(prev, payload([dep({ config: cfgB })], T0 + 2 * MIN), T0 + 2 * MIN);

  const ev = r.events.find((e) => e.type === "config");
  assert.ok(ev, "expected a config event");
  assert.equal(ev.signal, "whitelist");
  assert.deepEqual(ev.added, ["Bnot"]);
  assert.deepEqual(ev.removed, []);
  assert.equal(ev.dep, "dep-1");
  assert.match(ev.title, /^Whitelist changed:/);
  assert.match(ev.body, /1 joined: Bnot/);
  assert.match(ev.body, /^Whitelist roster change/);
});

test("a player leaving the whitelist is reported as a departure", () => {
  const cfgA = { "nv.module.TKB_Prime": { Team0Whitelist: "gr3my, dizzy, Bnot," } };
  const cfgB = { "nv.module.TKB_Prime": { Team0Whitelist: "gr3my, dizzy," } };

  let { prev } = tick(null, payload([dep({ config: cfgA })]), T0);
  const r = tick(prev, payload([dep({ config: cfgB })], T0 + 2 * MIN), T0 + 2 * MIN);

  const ev = r.events.find((e) => e.type === "config");
  assert.deepEqual(ev.removed, ["Bnot"]);
  assert.deepEqual(ev.added, []);
  assert.match(ev.body, /1 left: Bnot/);
});

test("non-whitelist config changes stay unflagged", () => {
  const cfgA = { "nv.module.TKB_Prime": { MaxPlayers: "16" } };
  const cfgB = { "nv.module.TKB_Prime": { MaxPlayers: "32" } };

  let { prev } = tick(null, payload([dep({ config: cfgA })]), T0);
  const r = tick(prev, payload([dep({ config: cfgB })], T0 + 2 * MIN), T0 + 2 * MIN);

  const ev = r.events.find((e) => e.type === "config");
  assert.ok(ev);
  assert.equal(ev.signal, undefined, "ordinary settings aren't a roster signal");
  assert.match(ev.title, /^Config changed:/);
});

test("whitelist edited but roster identical → flagged, no false join/leave", () => {
  // e.g. trailing whitespace / quote tidy: same people, different bytes
  const cfgA = { "nv.module.TKB_Prime": { Team0Whitelist: "gr3my, dizzy" } };
  const cfgB = { "nv.module.TKB_Prime": { Team0Whitelist: "gr3my, dizzy," } };

  let { prev } = tick(null, payload([dep({ config: cfgA })]), T0);
  const r = tick(prev, payload([dep({ config: cfgB })], T0 + 2 * MIN), T0 + 2 * MIN);

  const ev = r.events.find((e) => e.type === "config");
  assert.equal(ev.signal, "whitelist");
  assert.deepEqual(ev.added, []);
  assert.deepEqual(ev.removed, []);
  assert.match(ev.body, /roster is unchanged/);
});

test("state carries the live roster for the API to serve", () => {
  const cfg = { "nv.module.TKB_Prime": { Team0Whitelist: "gr3my, dizzy," } };
  const { prev } = tick(null, payload([dep({ config: cfg })]), T0);

  const key = "NAE/Communities:nv.module.TKB_Prime/Team0Whitelist";
  assert.deepEqual(prev.roster?.[key], ["gr3my", "dizzy"]);
});

test("buildRoster covers deployment and station-level whitelists", () => {
  const roster = buildRoster(
    [{ id: "d1", region: "EU", name: "Communities", config: { Team0Whitelist: "a, b" } }],
    { "station-1": { SubWhitelist: "c" } }
  );
  const values = Object.values(roster).flat();
  assert.deepEqual(values.sort(), ["a", "b", "c"]);
  // one key per whitelist found, namespaced by region + station
  assert.equal(Object.keys(roster).length, 2);
});

// ==========================================================================
// Feature 4 — peak hours
// ==========================================================================

const PEAK_FIXTURE = {
  "6_18": { n: 10, sum: 1000, max: 150 },   // Sat evening block
  "6_19": { n: 10, sum: 1200, max: 160 },
  "6_20": { n: 10, sum: 1400, max: 180 },
  "6_21": { n: 10, sum: 1200, max: 170 },
  "3_12": { n: 10, sum: 100, max: 30 },     // Wed lunchtime, quiet
  "0_20": { n: 5, sum: 500, max: 120 },     // Sun evening
  "2_9": { n: 1, sum: 40, max: 40 },        // Tue, under-sampled
};

test("peak: day-of-week rollup is sample-weighted", () => {
  const out = peakAnalytics(PEAK_FIXTURE);
  const byDow = Object.fromEntries(out.by_day.map((d) => [d.dow, d]));

  assert.deepEqual(Object.keys(byDow).map(Number).sort((a, b) => a - b), [0, 2, 3, 6]);
  assert.equal(byDow[6].n, 40);
  assert.equal(byDow[6].avg, 120, "(1000+1200+1400+1200)/40");
  assert.equal(byDow[6].max, 180);
  assert.equal(byDow[3].avg, 10);
  assert.equal(byDow[0].avg, 100);
  assert.equal(byDow[2].avg, 40, "under-sampled cell still reports its own average");
});

test("peak: hour-of-day rollup merges across days", () => {
  const out = peakAnalytics(PEAK_FIXTURE);
  const byHour = Object.fromEntries(out.by_hour.map((h) => [h.hour, h]));

  assert.equal(byHour[20].n, 15, "Sat + Sun 20:00 combined");
  assert.equal(byHour[20].avg, 127, "1900/15 rounds to 127");
  assert.equal(byHour[18].avg, 100);
  assert.equal(byHour[9].n, 1);
  assert.equal(Object.keys(byHour).length, 6);
});

test("peak: weekend vs weekday comparison", () => {
  const out = peakAnalytics(PEAK_FIXTURE);
  assert.equal(out.weekend.n, 45, "Sat 40 + Sun 5");
  assert.equal(out.weekend.avg, 118, "5300/45");
  assert.equal(out.weekday.n, 11, "Wed 10 + Tue 1");
  assert.equal(out.weekday.avg, 13, "140/11");
  assert.ok(out.weekend.avg > out.weekday.avg, "weekends should read busier here");
});

test("peak: busiest 4-hour window per day, never on thin samples", () => {
  const out = peakAnalytics(PEAK_FIXTURE);
  assert.equal(out.best_windows.length, 1, "only Saturday has 4 well-sampled hours");
  const [w] = out.best_windows;
  assert.equal(w.dow, 6);
  assert.equal(w.start, 18);
  assert.equal(w.end, 21);
  assert.equal(w.n, 40);
  assert.equal(w.avg, 120);
  // Sunday has only one sampled hour → no window claimed for it
  assert.ok(!out.best_windows.some((x) => x.dow === 0));
});

test("peak: best_hours ignores cells below the sample floor", () => {
  const out = peakAnalytics(PEAK_FIXTURE);
  assert.ok(!out.best_hours.some((h) => h.dow === 2 && h.hour === 9),
    "1 sample is not evidence");
  assert.equal(out.best_hours[0].dow, 6, "Saturday 20:00 is the true peak");
  assert.equal(out.best_hours[0].avg, 140);
  assert.equal(out.best_hours.length, 6, "6 of 7 cells cleared n>=3");
});

test("peak: raw cells are preserved alongside the rollups", () => {
  const out = peakAnalytics(PEAK_FIXTURE);
  assert.equal(out.cells.length, 7);
  assert.equal(out.samples, 56);
  assert.equal(out.min_samples, 3);
  assert.equal(out.window_hours, 4);
});

test("peak: empty matrix returns well-formed empty analytics", () => {
  const out = peakAnalytics({});
  assert.deepEqual(out.cells, []);
  assert.deepEqual(out.by_day, []);
  assert.deepEqual(out.by_hour, []);
  assert.deepEqual(out.best_windows, []);
  assert.equal(out.samples, 0);
  assert.deepEqual(out.weekend, { n: 0, avg: 0, max: 0 });
});

test("peak: malformed cell keys don't poison the rollups", () => {
  const out = peakAnalytics({ "nan_nan": { n: 3, sum: 30, max: 10 }, "6_20": { n: 5, sum: 50, max: 20 } });
  assert.equal(out.cells.length, 1, "NaN key dropped");
  assert.equal(out.by_day.length, 1);
  assert.equal(out.by_day[0].dow, 6);
});

// ==========================================================================
// Feature 5 — best-region advisor
// ==========================================================================

test("advise returns a scored shortlist of live regions only", () => {
  const regions = {
    NAE: { code: "NAE", servers: 2, online: 2, pop: 80 },
    NAW: { code: "NAW", servers: 1, online: 0, pop: 0 },   // dead
    EU: { code: "EU", servers: 1, online: 1, pop: 40 },
    OCE: { code: "OCE", servers: 1, online: 1, pop: 120 },
  };
  const a = advise(regions, "NA");

  assert.equal(a.status, "home_partial");          // NAW (home) is down
  assert.equal(a.recommended, "NAE");
  assert.equal(a.home_regions.length, 2);

  // dead regions never appear — recommending an offline server is useless
  assert.ok(!a.options.some((o) => o.code === "NAW"));
  assert.deepEqual(a.options.map((o) => o.code), ["NAE", "OCE", "EU"],
    "home beats the busier foreign region (geo +40 > pop advantage)");

  const top = a.options[0];
  assert.equal(top.home, true);
  assert.equal(top.pop, 80);
  assert.equal(top.online, 2);
  assert.equal(top.servers, 2);
  assert.ok(top.score > a.options[1].score);
  assert.match(top.why, /in NA/);
  assert.match(top.why, /80 players/);
  assert.match(top.why, /2\/2 up/);
});

test("advise scores population when no home region exists", () => {
  const regions = {
    EU: { code: "EU", servers: 1, online: 1, pop: 40 },
    OCE: { code: "OCE", servers: 1, online: 1, pop: 400 },
  };
  const a = advise(regions, "NA");
  assert.equal(a.status, "no_home_region");
  assert.equal(a.recommended, "OCE");
  assert.equal(a.options[0].code, "OCE");
  assert.equal(a.options[0].home, false);
});

test("advise penalises a half-deployed region against a healthy rival", () => {
  const regions = {
    NAE: { code: "NAE", servers: 2, online: 1, pop: 100 },  // busy but 1/2 up
    NAW: { code: "NAW", servers: 1, online: 1, pop: 60 },   // smaller, fully healthy
  };
  const a = advise(regions, "NA");
  // NAE: 40 geo + 35*100/100 + 15*0.5 + 0  = 82.5 → 83
  // NAW: 40 geo + 35*60/100  + 15*1   + 10  = 86
  assert.equal(a.recommended, "NAW",
    "a healthy smaller region beats a busy one that's missing a server");
  assert.equal(a.options[0].code, "NAW");
  assert.equal(a.options[0].score, 86);
});

test("advise: home region fully down falls back to the best available", () => {
  const regions = {
    NAE: { code: "NAE", servers: 1, online: 0, pop: 0 },
    NAW: { code: "NAW", servers: 1, online: 0, pop: 0 },
    EU: { code: "EU", servers: 1, online: 1, pop: 40 },
  };
  const a = advise(regions, "NA");
  assert.equal(a.status, "home_down");
  assert.equal(a.recommended, "EU");
  assert.match(a.reason, /higher ping/);
  assert.equal(a.options.length, 1, "only the live region is offered");
});

test("advise: no data anywhere", () => {
  const a = advise({}, "NA");
  assert.equal(a.status, "no_data");
  assert.equal(a.recommended, null);
  assert.deepEqual(a.options, []);
});

test("fmt groups large player counts for display", () => {
  assert.equal(fmtNum(1234567), "1,234,567");
  assert.equal(fmtNum(0), "0");
  assert.equal(fmtNum(undefined), "0");
});
