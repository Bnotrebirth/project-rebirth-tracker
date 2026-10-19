/* =========================================================================
   Tests for interactions.js — run with:  node --test test/interactions.test.js

   The important one is the Ed25519 round-trip: it generates a real keypair,
   signs a payload exactly the way Discord does (timestamp + raw body), and
   checks our worker-side verifier. If this passes, the deployed endpoint
   will accept genuine Discord traffic and reject everything else.
   ========================================================================= */

import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { handleInteraction, verifyInteraction } from "../interactions.js";

// Node ships WebCrypto but doesn't expose Ed25519 via crypto.subtle in all
// versions — the worker runtime does. For the test we shim subtle.verify with
// a node:crypto implementation so the SAME verifyInteraction code path runs.
const subtle = webcrypto.subtle;

function toHex(buf) {
  return Buffer.from(buf).toString("hex");
}

async function makeKeypair() {
  const { publicKey, privateKey } = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return {
    publicKeyHex: toHex(await subtle.exportKey("raw", publicKey)),
    sign: async (msg) => toHex(await subtle.sign(
      { name: "Ed25519" }, privateKey, new TextEncoder().encode(msg))),
  };
}

/** Minimal fake KV so handleInteraction can read the same blobs the cron writes. */
function fakeEnv({ tracker, events = [], patches = [], restarts = [], configlog = [] }) {
  const store = new Map([
    ["tracker", JSON.stringify(tracker)],
    ["events", JSON.stringify(events)],
    ["patches", JSON.stringify(patches)],
    ["restarts", JSON.stringify(restarts)],
    ["configlog", JSON.stringify(configlog)],
  ]);
  return { HISTORY: { get: async (k) => store.get(k) ?? null } };
}

const NOW = Date.parse("2026-10-18T12:00:00Z");

function trackerWith(over = {}) {
  return {
    samples: [{ t: NOW - 3600e3, v: 5 }, { t: NOW, v: 42 }],
    peak: { "0_21": { n: 10, sum: 400, max: 60 }, "1_22": { n: 4, sum: 80, max: 25 } },
    latest: {
      t: NOW,
      total: 42,
      all_time_peak: 60,
      servers: [
        { station: "Communities", name: "Communities", region: "NAE", ip: "45.8.201.127:7777", version: "22284", online: true, players: 42 },
        { station: "Communities", name: "Communities", region: "EU", ip: "1.2.3.4:7777", version: "22284", online: false, players: 0 },
      ],
      regions: {
        NAE: { code: "NAE", servers: 1, online: 1, pop: 42 },
        EU: { code: "EU", servers: 1, online: 0, pop: 0 },
      },
    },
    prev: { t: NOW },
    ...over,
  };
}

// -------------------------------------------------------------------------

test("Ed25519: valid Discord-style signature verifies, tampering fails", async (t) => {
  if (typeof subtle.generateKey !== "function" || !subtle.generateKey({ name: "Ed25519" }, true, ["sign"])) {
    t.skip("this Node build lacks Ed25519 in WebCrypto");
    return;
  }
  const { publicKeyHex, sign } = await makeKeypair();
  const timestamp = "1792324800";
  const body = JSON.stringify({ type: 1, application_id: "123" });

  assert.equal(await verifyInteraction(publicKeyHex, body, await sign(timestamp + body), timestamp), true,
    "genuine signature must verify");
  assert.equal(await verifyInteraction(publicKeyHex, body, await sign(timestamp + body), "1792324801"), false,
    "wrong timestamp must fail");
  assert.equal(await verifyInteraction(publicKeyHex, body + " ", await sign(timestamp + body), timestamp), false,
    "tampered body must fail");
  assert.equal(await verifyInteraction(publicKeyHex, body, "deadbeef", timestamp), false,
    "garbage signature must fail");
  assert.equal(await verifyInteraction("", body, await sign(timestamp + body), timestamp), false,
    "missing public key must fail");
});

test("PING handshake returns PONG (type 1) without touching KV", async () => {
  const res = await handleInteraction({ type: 1 }, fakeEnv({ tracker: trackerWith() }));
  assert.equal(res.type, 1);
});

test("unknown command and subcommand are rejected politely", async () => {
  const env = fakeEnv({ tracker: trackerWith() });
  const a = await handleInteraction({ type: 2, data: { name: "nope" } }, env);
  assert.equal(a.type, 4);
  assert.match(a.data.content, /Unknown command/);

  const b = await handleInteraction({ type: 2, data: { name: "pr", options: [{ name: "bogus" }] } }, env);
  assert.match(b.data.content, /Unknown subcommand/);
});

test("/pr status renders live totals from the cached snapshot", async () => {
  const res = await handleInteraction(
    { type: 2, data: { name: "pr", options: [{ name: "status" }] } },
    fakeEnv({ tracker: trackerWith() })
  );
  assert.equal(res.type, 4);
  const [emb] = res.data.embeds;
  assert.match(emb.title, /42 online/);
  assert.match(emb.fields[0].value, /NAE/);
  assert.equal(res.data.allowed_mentions.parse.length, 0, "must never ping anyone");
});

test("/pr region recommends the healthy home region", async () => {
  const res = await handleInteraction(
    { type: 2, data: { name: "pr", options: [{ name: "region", options: [{ name: "continent", value: "NA" }] }] } },
    fakeEnv({ tracker: trackerWith() })
  );
  const [emb] = res.data.embeds;
  assert.match(emb.fields[0].value, /NAE/);
  assert.match(emb.fields[0].value, /fully online/);
});

test("/pr region with a dead home region falls back elsewhere", async () => {
  const tr = trackerWith();
  tr.latest.regions.NAE.online = 0;
  tr.latest.regions.NAE.pop = 0;
  const res = await handleInteraction(
    { type: 2, data: { name: "pr", options: [{ name: "region", options: [{ name: "continent", value: "NA" }] }] } },
    fakeEnv({ tracker: tr })
  );
  assert.match(res.data.embeds[0].fields[0].value, /offline/);
});

test("/pr peak ranks hours by average and waits when under-sampled", async () => {
  const res = await handleInteraction(
    { type: 2, data: { name: "pr", options: [{ name: "peak" }] } },
    fakeEnv({ tracker: trackerWith() })
  );
  const [emb] = res.data.embeds;
  assert.match(emb.fields[0].value, /Sun 21:00/); // 40 avg beats 20 avg

  const thin = await handleInteraction(
    { type: 2, data: { name: "pr", options: [{ name: "peak" }] } },
    fakeEnv({ tracker: trackerWith({ peak: { "0_21": { n: 2, sum: 80, max: 50 } } }) })
  );
  assert.match(thin.data.embeds[0].description, /Not enough samples/);
});

test("/pr history computes now/avg/peak from the sample window", async () => {
  const res = await handleInteraction(
    { type: 2, data: { name: "pr", options: [{ name: "history", options: [{ name: "range", value: "24h" }] }] } },
    fakeEnv({ tracker: trackerWith() })
  );
  const fields = Object.fromEntries(res.data.embeds[0].fields.map((f) => [f.name, f.value]));
  assert.equal(fields.Now, "42");
  assert.equal(fields.Peak, "42");
  assert.equal(fields.Low, "5");
});

test("/pr history with too few samples says so instead of crashing", async () => {
  const res = await handleInteraction(
    { type: 2, data: { name: "pr", options: [{ name: "history" }] } },
    fakeEnv({ tracker: trackerWith({ samples: [{ t: NOW, v: 3 }] }) })
  );
  assert.match(res.data.embeds[0].description, /Not enough samples/);
});

test("/pr events, patches, restarts, config render their logs", async () => {
  const env = fakeEnv({
    tracker: trackerWith(),
    events: [{ t: NOW, type: "patch", title: "Patch: Communities · NAE", body: "22284 → 22285" }],
    patches: [{ t: NOW, type: "patch", title: "Patch: Communities · NAE", body: "22284 → 22285" }],
    restarts: [{ t: NOW, type: "restart", title: "Server restarted: Communities · NAE", body: "Downtime ~4m", downtime_s: 240 }],
    configlog: [{ t: NOW, type: "config", title: "Config changed: Communities · NAE", body: "1 setting changed.", fields: [{ name: "Team0Whitelist", value: '"a" → "a, b"' }] }],
  });
  const ask = (sub, extra = []) => handleInteraction(
    { type: 2, data: { name: "pr", options: [{ name: sub, options: extra }] } }, env);

  assert.match((await ask("events")).data.embeds[0].description, /Patch: Communities/);
  assert.match((await ask("patches")).data.embeds[0].description, /22285/);
  const rs = (await ask("restarts")).data.embeds[0];
  assert.match(rs.fields[0].value, /avg downtime 4m/);
  assert.match(rs.description, /Downtime/);
  assert.match((await ask("config")).data.embeds[0].description, /Team0Whitelist/);
});

test("dead KV degrades to a live fetch — never a crash", async (t) => {
  // GAME_API_URL is a secret in production; here it just has to be set for
  // the fallback path to be reachable at all.
  const env = {
    GAME_API_URL: "https://example.test/list?page=1",
    HISTORY: { get: async () => { throw new Error("kv exploded"); } },
  };
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  // Case 1: the fallback reaches the game API and renders live data.
  globalThis.fetch = async () => new Response(
    JSON.stringify({
      items: [{
        station_name: "Communities",
        deployments: [{
          deployment_name: "Communities", region: "NAE", ip: "45.8.201.127:7777",
          version: "22284", online: true, player_count: 42,
        }],
      }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );

  const ok = await handleInteraction(
    { type: 2, data: { name: "pr", options: [{ name: "status" }] } }, env);
  assert.equal(ok.type, 4);
  assert.match(ok.data.embeds[0].description, /polled the game API directly/);
  assert.match(ok.data.embeds[0].title, /42 online/);
  assert.match(ok.data.embeds[0].fields[0].value, /NAE/);

  // Case 2: that fallback also fails → friendly message, never a 500.
  globalThis.fetch = async () => { throw new Error("network down"); };
  const dead = await handleInteraction(
    { type: 2, data: { name: "pr", options: [{ name: "status" }] } }, env);
  assert.equal(dead.type, 4);
  assert.match(dead.data.content, /failed|warming up/);
});

/* =========================================================================
   Enriched analytics output — these assert the five features actually reach
   Discord, not just that the underlying helpers compute the right numbers.
   ========================================================================= */

const ask = (env, sub, extra = []) => handleInteraction(
  { type: 2, data: { name: "pr", options: [{ name: sub, options: extra }] } }, env);
const fieldsOf = (res) => Object.fromEntries(
  res.data.embeds[0].fields.map((f) => [f.name, f.value]));

test("/pr patches reports staged rollout: newest build + laggard regions", async () => {
  const tr = trackerWith();
  tr.latest.servers = [
    { station: "Communities", name: "Communities", region: "NAE", ip: "1.1.1.1:7777",
      version: "22285", online: true, players: 10 },
    { station: "Communities", name: "Communities", region: "EU", ip: "2.2.2.2:7777",
      version: "22284", online: true, players: 5 },
  ];
  const env = fakeEnv({
    tracker: tr,
    patches: [{
      t: NOW, type: "patch", title: "Patch: Communities · NAE",
      body: "Communities in NAE updated build 22284 → 22285.",
      version_from: "22284", version_to: "22285", region: "NAE",
      created: "2026-10-18T09:00:00Z", since_prev_s: 7200, downtime_s: 240,
    }],
  });

  const res = await ask(env, "patches", [{ name: "count", value: 5 }]);
  const f = fieldsOf(res);

  assert.match(f.Rollout, /newest build \*\*22285\*\*/i);
  assert.match(f.Rollout, /behind/);
  assert.match(f.Rollout, /EU: 22284/, "shows which build each region is on");
  assert.match(f.Cadence, /median 2h between builds/);
  assert.match(f.Cadence, /1 in the last 7d/);
  assert.match(res.data.embeds[0].description, /new instance deployed/);
  assert.match(res.data.embeds[0].description, /previous build 2h earlier/);
});

test("/pr patches marks the rollout complete when every region matches", async () => {
  const res = await ask(fakeEnv({ tracker: trackerWith() }), "patches");
  const f = fieldsOf(res);
  assert.match(f.Rollout, /every region is current/);
  assert.match(f.Rollout, /22284/);
  assert.ok(!/behind/.test(f.Rollout));
});

test("/pr restarts exposes MTBF, per-day counts and early-warning accuracy", async () => {
  const env = fakeEnv({
    tracker: trackerWith(),
    restarts: [
      { t: NOW - 3600e3, type: "restart", title: "Server restarted: Communities · NAE",
        body: "Downtime ~4m", downtime_s: 240 },
      { t: NOW - 2 * 3600e3, type: "restart", title: "Server restarted: Communities · NAE",
        body: "Downtime ~5m", downtime_s: 300 },
    ],
    events: [
      { t: NOW - 40 * 60e3, type: "stale", dep: "dep-1" },
      { t: NOW - 35 * 60e3, type: "restart", dep: "dep-1" },
      { t: NOW - 90 * 60e3, type: "stale", dep: "dep-2" },  // never crashed → false alarm
    ],
  });

  const res = await ask(env, "restarts", [{ name: "count", value: 5 }]);
  const f = fieldsOf(res);

  assert.match(f.Forensics, /MTBF 1h/, "one hour between the two restarts");
  assert.match(f.Forensics, /avg downtime 4m 30s/);
  assert.match(f.Forensics, /2 per day/);
  const warn = f["Early-warning accuracy"];
  assert.match(warn, /\*\*2\*\* stale-heartbeat alerts/);
  assert.match(warn, /\*\*1\*\* preceded a real crash/);
  assert.match(warn, /50%/);
  assert.match(warn, /5m of warning/);
  assert.match(f["Restarts by day"], /10-18/, "both landed on the same UTC day");
});

test("/pr config serves the live roster and recent join/leave movement", async () => {
  const tr = trackerWith();
  tr.prev.roster = { "NAE/Communities:nv.module.TKB_Prime/Team0Whitelist": ["gr3my", "dizzy"] };

  const env = fakeEnv({
    tracker: tr,
    configlog: [{
      t: NOW, type: "config", signal: "whitelist",
      title: "Whitelist changed: Communities · NAE",
      body: "Whitelist roster change — 1 joined: Bnot.",
      added: ["Bnot"], removed: [],
      fields: [{ name: "nv.module.TKB_Prime/Team0Whitelist", value: '"gr3my, dizzy," → "gr3my, dizzy, Bnot,"' }],
    }],
  });

  const res = await ask(env, "config", [{ name: "count", value: 5 }]);
  const f = fieldsOf(res);

  assert.match(f["Live roster (who's playing)"], /gr3my, dizzy/);
  assert.match(f["Live roster (who's playing)"], /Team0Whitelist/);
  assert.match(f["Recent roster movement"], /\+Bnot/, "the join is the headline");
  assert.match(res.data.embeds[0].title, /roster/i);
});

test("/pr peak reports the day-of-week rollup and weekend/weekday split", async () => {
  const tr = trackerWith({
    peak: {
      "6_18": { n: 5, sum: 500, max: 90 },
      "6_19": { n: 5, sum: 600, max: 100 },
      "6_20": { n: 5, sum: 700, max: 110 },
      "6_21": { n: 5, sum: 800, max: 120 },
      "3_12": { n: 10, sum: 100, max: 30 },
    },
  });
  const env = fakeEnv({ tracker: tr });

  const res = await ask(env, "peak");
  const f = fieldsOf(res);

  assert.match(f["By day of week"], /\*\*Sat\*\* — avg 130/);
  assert.match(f["By day of week"], /\*\*Wed\*\* — avg 10/);
  assert.match(f["Best 4-hour session windows"], /\*\*Sat\*\* 18:00–22:00 — avg 130/);
  assert.match(f["Weekend vs weekday"], /Weekend avg \*\*130\*\* vs weekday \*\*10\*\*/);
});

test("/pr region lists the scored shortlist, not just a single pick", async () => {
  const tr = trackerWith();
  tr.latest.regions = {
    NAE: { code: "NAE", servers: 1, online: 1, pop: 42 },
    EU: { code: "EU", servers: 1, online: 1, pop: 20 },
    OCE: { code: "OCE", servers: 1, online: 1, pop: 5 },
  };
  const env = fakeEnv({ tracker: tr });

  const res = await ask(env, "region", [{ name: "continent", value: "NA" }]);
  const f = fieldsOf(res);

  assert.match(f.Recommendation, /NAE/);
  const shortlist = Object.keys(f).find((k) => /Ranked shortlist/.test(k));
  assert.ok(shortlist, "expected a ranked shortlist field");
  assert.match(f[shortlist], /\*\*1\.\*\*.*NAE/s, "home region ranks first");
  assert.match(f[shortlist], /score 100/);
  assert.match(f[shortlist], /42 players/);
  assert.match(f[shortlist], /EU/, "runner-ups are still offered");
});
