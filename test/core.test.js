/* =========================================================================
   Tests for core.js — run with:  npm test   (node --test test/core.test.js)
   Drives tick() with synthetic snapshots and injected timestamps so every
   alert path is verified without touching the live API.
   ========================================================================= */

import test from "node:test";
import assert from "node:assert/strict";
import {
  tick, diffConfig, advise, embedBatches, eventToEmbed,
  SERVER_MILESTONES, GLOBAL_MILESTONES, STATE_VERSION, STALE_MS, COOLDOWN_MS,
} from "../core.js";

const T0 = Date.parse("2026-10-18T12:00:00Z");
const MIN = 60_000;

/**
 * Build a server-browser `items[]` payload from a compact dep spec list.
 * `agoMin` = how many minutes before `at` the heartbeat was (default: fresh).
 */
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
const types = (events) => events.map((e) => e.type);
const find = (events, type) => events.find((e) => e.type === type);

// -------------------------------------------------------------------------

test("bootstrap: first tick seeds state silently, zero events", () => {
  const { events, prev, bootstrapped } = tick(null, payload([dep({ players: 35 })]), T0);
  assert.equal(bootstrapped, true);
  assert.deepEqual(events, []);
  assert.equal(prev.v, STATE_VERSION);
  assert.equal(prev.total_online, 35);
  // milestone ladder seeded so "35 online" doesn't re-alert at 25
  assert.equal(prev.deps["dep-1"].ms, 25);
  assert.equal(prev.all_time_peak, 35);
});

test("server_up / server_down transitions", () => {
  let { prev } = tick(null, payload([dep({ online: false })]), T0);

  let r = tick(prev, payload([dep({ online: true, players: 4 })], T0 + 2 * MIN), T0 + 2 * MIN);
  assert.deepEqual(types(r.events), ["server_up"]);

  r = tick(r.prev, payload([dep({ online: false })], T0 + 4 * MIN), T0 + 4 * MIN);
  assert.deepEqual(types(r.events), ["server_down"]);
  assert.match(r.events[0].body, /was 4 players/);
});

test("cooldown suppresses a flapping server", () => {
  let { prev } = tick(null, payload([dep({ online: false })]), T0);
  let t = T0;
  const seen = [];
  for (let i = 0; i < 6; i++) {
    t += MIN;
    const r = tick(prev, payload([dep({ online: i % 2 === 0 })], t), t);
    prev = r.prev;
    seen.push(...types(r.events));
  }
  // 6 flips in 6 minutes: one up + one down, everything else deduped
  assert.deepEqual(seen, ["server_up", "server_down"]);
  // after the cooldown window it may fire again
  t += COOLDOWN_MS + MIN;
  const r = tick(prev, payload([dep({ online: true })], t), t);
  assert.ok(types(r.events).includes("server_up"));
});

test("per-server milestones fire once and don't repeat on the same number", () => {
  let { prev } = tick(null, payload([dep({ players: 3 })]), T0);
  let r = tick(prev, payload([dep({ players: 27 })], T0 + 2 * MIN), T0 + 2 * MIN);
  // crossed 10 + 25 in one jump -> single event for the highest rung
  assert.deepEqual(types(r.events), ["milestone", "peak_record"]);
  assert.match(r.events[0].title, /^27 players online/);

  r = tick(r.prev, payload([dep({ players: 26 })], T0 + 4 * MIN), T0 + 4 * MIN);
  assert.deepEqual(r.events, [], "no re-alert for lower count");

  r = tick(r.prev, payload([dep({ players: 51 })], T0 + 6 * MIN), T0 + 6 * MIN);
  assert.deepEqual(types(r.events), ["milestone", "peak_record"]);
  assert.match(r.events[0].title, /^51 players online/);
  assert.ok(SERVER_MILESTONES.includes(50));
});

test("patch: version bump announces old → new build", () => {
  let { prev } = tick(null, payload([dep({ version: "22284", players: 20 })]), T0);
  const r = tick(prev, payload([dep({ version: "22285", players: 1 })], T0 + 5 * MIN), T0 + 5 * MIN);
  assert.deepEqual(types(r.events), ["patch"]);
  assert.match(r.events[0].body, /22284 → 22285/);
});

test("restart: created changes → restart event with downtime, milestone resets", () => {
  let { prev } = tick(null, payload([dep({ players: 60 })]), T0);
  // server dies (offline) for 8 minutes...
  let r = tick(prev, payload([dep({ online: false })], T0 + 2 * MIN), T0 + 2 * MIN);
  // ...then returns as a new instance with a few players back
  r = tick(r.prev, payload([dep({ players: 3, created: "2026-10-18T08:00:00Z" })], T0 + 10 * MIN), T0 + 10 * MIN);
  const ev = find(r.events, "restart");
  assert.ok(ev, `expected restart event, got ${types(r.events).join(",")}`);
  assert.match(ev.body, /Downtime ~8m/);
  // new instance re-seeded: 3 players is below the 10 rung → no milestone
  assert.ok(!r.events.some((e) => e.type === "milestone"));
  // and climbing back to 30 alerts fresh (old progress was 60)
  r = tick(r.prev, payload([dep({ players: 30, created: "2026-10-18T08:00:00Z" })], T0 + 12 * MIN), T0 + 12 * MIN);
  assert.deepEqual(types(r.events), ["milestone"]);
  assert.match(r.events[0].title, /^30 players online/);
});

test("patch + redeploy in one tick → single patch event, mentions downtime", () => {
  let { prev } = tick(null, payload([dep({ version: "22284" })]), T0);
  const r = tick(prev, payload([dep({
    version: "22285", created: "2026-10-18T09:00:00Z", online: false,
  })], T0 + 4 * MIN), T0 + 4 * MIN);
  assert.deepEqual(types(r.events), ["patch"]);
  assert.match(r.events[0].body, /Redeployed \(downtime ~4m\)/);
});

test("stale heartbeat alerts, then recovery", () => {
  let { prev } = tick(null, payload([dep({ players: 5 })]), T0);
  // heartbeat drifts past STALE_MS
  const r = tick(prev, payload([dep({ players: 5, agoMin: 12 })], T0 + 2 * MIN), T0 + 2 * MIN);
  assert.deepEqual(types(r.events), ["stale"]);
  // fresh heartbeat again
  const r2 = tick(r.prev, payload([dep({ players: 5, agoMin: 0 })], T0 + 4 * MIN), T0 + 4 * MIN);
  assert.deepEqual(types(r2.events), ["recovered"]);
});

test("config drift reports changed leaf keys with old → new values", () => {
  const cfgA = { "nv.module.TKB_Prime": { bUseWhitelist: "true", Team0Whitelist: "gr3my, dizzy," } };
  const cfgB = { "nv.module.TKB_Prime": { bUseWhitelist: "true", Team0Whitelist: "gr3my, dizzy, Bnot," } };
  let { prev } = tick(null, payload([dep({ config: cfgA })]), T0);
  const r = tick(prev, payload([dep({ config: cfgB })], T0 + 2 * MIN), T0 + 2 * MIN);
  const ev = find(r.events, "config");
  assert.ok(ev);
  assert.equal(ev.fields.length, 1);
  assert.match(ev.fields[0].name, /Team0Whitelist/);
  assert.match(ev.fields[0].value, /"gr3my, dizzy," → "gr3my, dizzy, Bnot,"/);
});

test("diffConfig handles additions, removals, nested + array leaves", () => {
  const d = diffConfig(
    { a: { b: "1" }, list: ["x", "y"], gone: true },
    { a: { b: "2" }, list: ["x", "z"], added: 5 }
  );
  const keys = d.map((x) => x.key);
  assert.deepEqual(keys.sort(), ["a/b", "added", "gone", "list/1"].sort());
});

test("region death and rebirth (multi-server regions only)", () => {
  const two = (online) => [
    dep({ id: "dep-1", region: "OCE", online }),
    dep({ id: "dep-2", region: "OCE", online }),
  ];
  let { prev } = tick(null, payload(two(false)), T0);
  let r = tick(prev, payload(two(true).map((d) => ({ ...d, players: 2 })), T0 + 2 * MIN), T0 + 2 * MIN);
  assert.deepEqual(types(r.events), ["server_up", "server_up", "region_rebirth"]);
  r = tick(r.prev, payload(two(false), T0 + 4 * MIN), T0 + 4 * MIN);
  assert.deepEqual(types(r.events), ["server_down", "server_down", "region_death"]);
});

test("single-server regions don't double-report as region death", () => {
  // region death would be the same fact as server_down — engine must stay quiet
  let { prev } = tick(null, payload([dep({ online: true, players: 2 })]), T0);
  const r = tick(prev, payload([dep({ online: false })], T0 + 2 * MIN), T0 + 2 * MIN);
  assert.deepEqual(types(r.events), ["server_down"]);
});

test("global milestone + all-time peak record (deduped against server milestone)", () => {
  // two servers so per-server rungs (12, 14) differ from the global rung (26)
  const both = (a, b) => [
    dep({ id: "dep-1", players: a }),
    dep({ id: "dep-2", players: b }),
  ];
  let { prev } = tick(null, payload(both(10, 8)), T0);
  const r = tick(prev, payload(both(12, 14), T0 + 2 * MIN), T0 + 2 * MIN);
  const ts = types(r.events);
  assert.ok(ts.includes("milestone"), "dep-2 crossed its own 10 rung");
  assert.ok(ts.includes("global_milestone"), "total crossed 25");
  assert.ok(ts.includes("peak_record"), "26 beat the old peak of 18");
  assert.equal(r.prev.all_time_peak, 26);
  // same counts again → nothing
  const r2 = tick(r.prev, payload(both(12, 14), T0 + 4 * MIN), T0 + 4 * MIN);
  assert.deepEqual(r2.events, []);
});

test("single-server global milestone isn't announced twice", () => {
  let { prev } = tick(null, payload([dep({ players: 10 })]), T0);
  const r = tick(prev, payload([dep({ players: 30 })], T0 + 2 * MIN), T0 + 2 * MIN);
  // server rung 25 === global rung 25 → one milestone + the peak record only
  assert.deepEqual(types(r.events), ["milestone", "peak_record"]);
});

test("removed deployment announces server_down", () => {
  let { prev } = tick(null, payload([dep({ players: 9 }), dep({ id: "dep-2", name: "Second" })]), T0);
  const r = tick(prev, payload([dep({ players: 9 })], T0 + 2 * MIN), T0 + 2 * MIN);
  const ev = find(r.events, "server_down");
  assert.ok(ev);
  assert.match(ev.title, /Second/);
});

test("advise(): picks home region, warns when home is dead", () => {
  const regions = {
    NAE: { code: "NAE", servers: 2, online: 2, pop: 80 },
    NAW: { code: "NAW", servers: 1, online: 0, pop: 0 },
    EU: { code: "EU", servers: 1, online: 1, pop: 40 },
  };
  let a = advise(regions, "NA");
  assert.equal(a.status, "home_partial");
  assert.equal(a.recommended, "NAE");

  regions.NAE.online = 0; regions.NAE.pop = 0;
  a = advise(regions, "NA");
  assert.equal(a.status, "home_down");
  assert.equal(a.recommended, "EU"); // best alive fallback

  a = advise({}, "NA");
  assert.equal(a.status, "no_data");
});

test("embeds: one per event, chunked to 10 per webhook message", () => {
  const events = Array.from({ length: 23 }, (_, i) => ({
    t: T0, type: "server_up", title: `ev ${i}`, body: "b", fields: [{ name: "n", value: "v" }],
  }));
  const batches = embedBatches(events);
  assert.equal(batches.length, 3);
  assert.equal(batches[0].embeds.length, 10);
  assert.equal(batches[2].embeds.length, 3);
  const emb = eventToEmbed(events[0]);
  assert.equal(emb.footer.text, "Project Rebirth Watcher");
  assert.ok(typeof emb.color === "number");
  assert.ok(emb.timestamp.endsWith("Z"));
});

test("long soak: 3 simulated days of churn keep state coherent", () => {
  let { prev } = tick(null, payload([dep({ players: 12 })]), T0);
  let t = T0;
  const counts = {};
  for (let i = 1; i <= 2160; i++) {          // 3 days at 2-min ticks
    t += 2 * MIN;
    const phase = Math.floor(i / 30) % 4;    // rotate: alive → patch → restart → dead
    const spec = phase === 0
      ? dep({ players: 12 + (i % 40) })
      : phase === 1
        ? dep({ players: 5, version: `2228${4 + Math.floor(i / 60) % 5}` })
        : phase === 2
          ? dep({ players: 8, created: new Date(t).toISOString() })
          : dep({ online: false });
    const r = tick(prev, payload([spec], t), t);
    prev = r.prev;
    for (const e of r.events) counts[e.type] = (counts[e.type] || 0) + 1;
  }
  // coherent invariants after 72 hours
  assert.equal(prev.v, STATE_VERSION);
  // phase 0 maxes at 12 + 29 = 41 players
  assert.ok(prev.all_time_peak >= 41, `peak should have tracked the highs, got ${prev.all_time_peak}`);
  // phase churn produced its share of events (server_down is intentionally
  // absent: phase transitions change `created`, which routes to restart)
  assert.ok(counts.patch >= 10 && counts.restart >= 10 && counts.milestone >= 10,
    `expected churn events, got ${JSON.stringify(counts)}`);
  // cooldown bookkeeping stays pruned
  assert.ok(Object.keys(prev.cooldown).length < 50);
});
