/* =========================================================================
   Project Rebirth — analytics layer (pure functions, no I/O)

   Shared by worker.js (JSON API routes) and interactions.js (Discord slash
   commands) so both surfaces report identical numbers. Pure functions of the
   raw event logs, which keeps them straightforward to unit test.

   Feature coverage:
     patchRollout / patchStats  → build timeline + staged-rollout state
     restartForensics           → MTBF, restarts/day, stale-warning accuracy
     peakAnalytics              → day-of-week / hour-of-day concurrency rollups
   ========================================================================= */

//
// These helpers turn raw event logs into the five analysis views. They are
// pure functions of the log arrays so they stay trivially testable.

const DAY_MS = 24 * 3600e3;

/** Arithmetic mean, or null for an empty sample. */
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Median of a numeric sample, or null. */
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** [{day:"YYYY-MM-DD", n}] ascending, for the restarts-per-day histogram. */
function byCalendarDay(events, now = Date.now(), windowDays = 14) {
  const counts = new Map();
  for (const e of events) {
    if (now - e.t > windowDays * DAY_MS) continue;
    const k = utcDay(e.t);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, n]) => ({ day, n }));
}

/**
 * Restart/crash forensics.
 *
 * MTBF here is the *observed* mean gap between consecutive restarts across
 * the retained log — not the 24h-count shortcut, which swings wildly when a
 * region does two rolling updates in an hour and then behaves for a week.
 *
 * `stale_warnings` scores whether the heartbeat-staleness alert actually
 * preceded a crash for the same deployment, i.e. is the early warning worth
 * anything? A warning counts as a hit if a restart/server_down for that same
 * deployment followed within `window_s`.
 */
function restartForensics(restarts, events, now = Date.now()) {
  const day = restarts.filter((r) => now - r.t < DAY_MS);
  const week = restarts.filter((r) => now - r.t < 7 * DAY_MS);

  const downtimes = restarts
    .map((r) => r.downtime_s)
    .filter((x) => Number.isFinite(x) && x > 0);

  // Mean gap between consecutive restarts (chronological, all retained).
  const times = restarts.map((r) => r.t).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / 1000);
  const mtbf = mean(gaps);

  const by_day = byCalendarDay(restarts, now);
  const observedDays = Math.max(1, by_day.length);

  // ---- stale-heartbeat → crash correlation ----
  const WINDOW_S = 30 * 60;
  const chrono = [...events].sort((a, b) => a.t - b.t);
  const crashes = chrono.filter((e) => e.type === "restart" || e.type === "server_down");
  let fired = 0;
  let predicted = 0;
  const leads = [];
  for (const w of chrono) {
    if (w.type !== "stale" || !w.dep) continue;
    fired++;
    const hit = crashes.find(
      (c) => c.dep === w.dep && c.t >= w.t && c.t - w.t <= WINDOW_S * 1000
    );
    if (hit) {
      predicted++;
      leads.push((hit.t - w.t) / 1000);
    }
  }

  return {
    last_24h: day.length,
    last_7d: week.length,
    total: restarts.length,
    avg_downtime_s: downtimes.length ? Math.round(mean(downtimes)) : null,
    median_downtime_s: downtimes.length ? Math.round(median(downtimes)) : null,
    mtbf_h: mtbf != null ? Number((mtbf / 3600).toFixed(2)) : null,
    restarts_per_day: Number((restarts.length / observedDays).toFixed(2)),
    by_day,
    stale_warnings: {
      fired,
      predicted,
      false_alarms: fired - predicted,
      hit_rate: fired ? Number((predicted / fired).toFixed(2)) : null,
      median_lead_s: leads.length ? Math.round(median(leads)) : null,
      window_s: WINDOW_S,
    },
  };
}

/**
 * Patch timeline + rollout state: which build each region is on right now,
 * and who is still lagging behind the newest build we've seen anywhere.
 * This is the "release channel" view — no official changelog required.
 */
function patchRollout(servers = []) {
  const numeric = (v) => (/^\d+$/.test(String(v)) ? Number(v) : null);
  const versions = [...new Set(servers.map((s) => s.version).filter(Boolean))];
  versions.sort((a, b) => {
    const na = numeric(a);
    const nb = numeric(b);
    if (na != null && nb != null) return nb - na;
    return String(b).localeCompare(String(a));
  });
  const newest = versions[0] || null;

  const regions = {};
  for (const s of servers) {
    if (!s.region || !s.version) continue;
    const set = (regions[s.region] ||= new Set());
    set.add(s.version);
  }
  const regionBuilds = {};
  for (const [code, set] of Object.entries(regions)) {
    const list = [...set];
    const sorted = list.slice().sort((a, b) => {
      const na = numeric(a);
      const nb = numeric(b);
      if (na != null && nb != null) return nb - na;
      return String(b).localeCompare(String(a));
    });
    regionBuilds[code] = sorted;
  }

  const lagging = Object.entries(regionBuilds)
    .filter(([, list]) => newest && !list.includes(newest))
    .map(([code]) => code)
    .sort();

  return {
    newest_build: newest,
    builds_seen: versions,
    regions: Object.fromEntries(Object.entries(regionBuilds).map(([c, l]) => [c, l[0]])),
    region_builds: regionBuilds,
    lagging,
    rollout_complete: !!newest && lagging.length === 0,
  };
}

/** Patch cadence stats straight off the structured event fields. */
function patchStats(patches, now = Date.now()) {
  const intervals = patches
    .map((p) => p.since_prev_s)
    .filter((x) => Number.isFinite(x) && x > 0);
  const last = patches.reduce((m, p) => Math.max(m, p.t || 0), 0);
  return {
    total: patches.length,
    last_24h: patches.filter((p) => now - p.t < DAY_MS).length,
    last_7d: patches.filter((p) => now - p.t < 7 * DAY_MS).length,
    last_patch_at: last || null,
    median_interval_h: intervals.length
      ? Number((median(intervals) / 3600).toFixed(1))
      : null,
    builds_tracked: new Set(patches.map((p) => p.version_to).filter(Boolean)).size,
  };
}

/**
 * Peak-hours analytics (feature 4).
 *
 * The raw day×hour matrix is the source of truth; everything else here is a
 * rollup of it:
 *   by_day        → day-of-week totals (is Saturday busier than Tuesday?)
 *   by_hour       → hour-of-day totals (is 20:00 always the peak?)
 *   weekend/weekday → the two headline populations side by side
 *   best_windows  → busiest contiguous 4-hour block per day, the practical
 *                   "when should I organise a session" answer
 * Rollups are sample-weighted (sum/n across cells), not averages-of-averages,
 * so a lightly sampled cell can't skew a whole day.
 */
function peakAnalytics(peak = {}) {
  const MIN_N = 3;   // minimum samples before an hour/day counts as a real signal
  const WINDOW = 4;  // hours in a candidate "session window"

  // Filter at the source: every rollup below aggregates `raw`, so a corrupt
  // key ("nan_nan") must never reach it or it would invent a NaN day.
  const raw = Object.entries(peak)
    .map(([key, c]) => {
      const [dow, hour] = key.split("_").map(Number);
      return { dow, hour, n: c.n || 0, sum: c.sum || 0, max: c.max || 0 };
    })
    .filter((c) =>
      Number.isFinite(c.dow) && Number.isFinite(c.hour) &&
      c.dow >= 0 && c.dow <= 6 && c.hour >= 0 && c.hour <= 23
    );

  const cells = raw.map((c) => ({
    dow: c.dow,
    hour: c.hour,
    n: c.n,
    max: c.max,
    avg: c.n ? Math.round(c.sum / c.n) : 0,
  }));

  const aggregate = (pickKey) => {
    const m = new Map();
    for (const c of raw) {
      const k = pickKey(c);
      const acc = m.get(k) || { k, n: 0, sum: 0, max: 0 };
      acc.n += c.n;
      acc.sum += c.sum;
      acc.max = Math.max(acc.max, c.max);
      m.set(k, acc);
    }
    return [...m.values()];
  };
  const finalize = (rows) =>
    rows.map((x) => ({ key: x.k, n: x.n, max: x.max, avg: x.n ? Math.round(x.sum / x.n) : 0 }));

  const by_day = finalize(aggregate((c) => c.dow))
    .sort((a, b) => a.key - b.key)
    .map(({ key, ...rest }) => ({ dow: key, ...rest }));

  const by_hour = finalize(aggregate((c) => c.hour))
    .sort((a, b) => a.key - b.key)
    .map(({ key, ...rest }) => ({ hour: key, ...rest }));

  const split = (list) => {
    const n = list.reduce((a, c) => a + c.n, 0);
    const sum = list.reduce((a, c) => a + c.sum, 0);
    return {
      n,
      avg: n ? Math.round(sum / n) : 0,
      max: list.reduce((a, c) => Math.max(a, c.max), 0),
    };
  };
  const weekendCells = raw.filter((c) => c.dow === 0 || c.dow === 6);
  const weekdayCells = raw.filter((c) => c.dow !== 0 && c.dow !== 6);

  // Busiest contiguous WINDOW-hour block per day-of-week. Every hour in the
  // candidate must clear MIN_N or we'd be recommending an untested slot.
  const best_windows = [];
  for (let dow = 0; dow < 7; dow++) {
    const byHour = new Array(24).fill(null);
    for (const c of raw) if (c.dow === dow) byHour[c.hour] = c;
    let best = null;
    for (let start = 0; start + WINDOW <= 24; start++) {
      const win = byHour.slice(start, start + WINDOW);
      if (win.some((h) => !h || h.n < MIN_N)) continue;
      const n = win.reduce((a, h) => a + h.n, 0);
      const sum = win.reduce((a, h) => a + h.sum, 0);
      const avg = n ? sum / n : 0;
      if (!best || avg > best.avg) {
        best = { dow, start, end: start + WINDOW - 1, n, avg: Math.round(avg) };
      }
    }
    if (best) best_windows.push(best);
  }

  const best_hours = cells
    .filter((c) => c.n >= MIN_N)
    .sort((a, b) => b.avg - a.avg || b.max - a.max)
    .slice(0, 6);

  return {
    cells,
    by_day,
    by_hour,
    weekend: split(weekendCells),
    weekday: split(weekdayCells),
    best_hours,
    best_windows,
    samples: raw.reduce((a, c) => a + c.n, 0),
    min_samples: MIN_N,
    window_hours: WINDOW,
  };
}

// Exported for the test suite (wrangler bundles them harmlessly alongside
// the default export; keeping them testable is worth the extra keywords).
export { restartForensics, patchRollout, patchStats, peakAnalytics };
