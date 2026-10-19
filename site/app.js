/* =========================================================================
   Project Rebirth — Live Statistics

   This page has no idea where the game backend lives, and never contacts it.
   Everything on screen comes from the watcher worker's own API, reached with
   same-origin relative paths:

     GET /api/state      live snapshot: servers, regions, totals, continent
     GET /history.json   30 days of 1-minute player-count samples
     GET /api/*          the ops panels (events, patches, restarts, ...)

   The worker polls the backend on a cron and caches it in KV, so the only
   host this page ever talks to is the one serving the page.
   ========================================================================= */

const REFRESH_MS = 30_000;
const SAMPLE_MS = 60_000;           // one history point per minute max
const HISTORY_KEY = 'pr_player_history_v1';
const MAX_HISTORY = 20_000;

const RANGE_MS = { '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3, '30d': 30 * 24 * 3600e3 };

const state = {
  stations: [],
  continent: null,
  range: '24h',
  regionFilter: 'ALL',
  search: '',
  openStation: null,
  loading: false,
  error: null,
  lastUpdated: null,
  history: [],
  nextRefreshAt: Date.now() + REFRESH_MS,
};

// ---------------- history ----------------
// Preferred source: /history.json served by the worker out of KV (real,
// server-side, shared by every visitor). Fallback: localStorage, recorded
// while the tab is open. Set true once we confirm the server file loaded.
state.historyFromServer = false;

async function loadHistoryFromServer() {
  try {
    // cache-bust so we always see the worker's newest samples
    const res = await fetch(`history.json?_=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json();
    const arr = Array.isArray(json) ? json : json?.samples;
    if (!Array.isArray(arr) || !arr.length) return null;
    // keep only well-formed {t,v} points
    return arr.filter((s) => s && Number.isFinite(s.t) && Number.isFinite(s.v));
  } catch {
    return null; // no history yet (KV empty) or blocked
  }
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function saveHistory() {
  if (state.historyFromServer) return; // collector owns the file; don't clobber
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history.slice(-MAX_HISTORY))); } catch {}
}

function recordSample(total) {
  const now = Date.now();
  const last = state.history[state.history.length - 1];
  if (last && now - last.t < SAMPLE_MS) { last.v = total; last.t = now; }
  else state.history.push({ t: now, v: total });
  saveHistory();
}

// ---------------- DOM ----------------
const $ = (id) => document.getElementById(id);
const els = {
  total: $('totalPlayers'),
  rangeStats: $('rangeStats'),
  rangeToggle: $('rangeToggle'),
  chart: $('chart'),
  chartTip: $('chartTip'),
  stationList: $('stationList'),
  auto: $('autoRefresh'),
  lastUpdated: $('lastUpdated'),
  countdown: $('countdown'),
  statusDot: $('statusDot'),
  statusText: $('statusText'),
  toast: $('toast'),
};

// ---------------- data ----------------
// The watcher worker owns every connection to the game backend; this page
// only ever asks the worker what it already knows. A single call covers the
// whole dashboard: servers, regions, global total and the caller's continent.
async function apiGet(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`tracker API returned HTTP ${res.status}`);
  return res.json();
}

/**
 * The worker's flat server list → the per-station shape the renderer uses.
 * Deployments are grouped under the station that owns them.
 */
function stationsFromState(servers) {
  const grouped = new Map();
  for (const s of servers || []) {
    const key = s.station || 'Unknown station';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({
      deployment_name: s.name || '',
      region: s.region || 'UNK',
      online: !!s.online,
      player_count: s.players,
      ip: s.ip || '',
      version: s.version || '',
      created: s.created || '',
      last_event: s.last_event || '',
      config: null,        // the snapshot deliberately carries no raw config
    });
  }
  return [...grouped.entries()].map(([name, deployments]) => ({
    station_id: name,
    station_name: name,
    deployments,
  }));
}

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  try {
    const snap = await apiGet('/api/state');
    state.stations = stationsFromState(snap.servers);
    state.continent = snap.continent || null;
    state.error = null;
    state.lastUpdated = new Date(Number(snap.generated_at) || Date.now());
    if (state.historyFromServer) {
      // The worker owns history — re-pull it so the chart keeps growing.
      const fresh = await loadHistoryFromServer();
      if (fresh && fresh.length) state.history = fresh;
    } else {
      recordSample(totalPlayers());
    }
    setStatus('live', state.continent ? `${state.continent} · live` : 'live');
  } catch (err) {
    state.error = err.message;
    setStatus(state.stations.length ? 'stale' : 'offline', state.stations.length ? 'stale data' : 'tracker unreachable');
  } finally {
    state.loading = false;
    state.nextRefreshAt = Date.now() + REFRESH_MS;
    renderAll();
  }
}

// ---------------- helpers ----------------
function totalPlayers(stations = state.stations) {
  return stations.reduce(
    (sum, s) => sum + (s.deployments ?? []).reduce((n, d) => n + (d.online ? Number(d.player_count) || 0 : 0), 0),
    0
  );
}

function allDeps() {
  return state.stations.flatMap((s) => (s.deployments ?? []).map((d) => ({ station: s, dep: d })));
}

function relTime(iso) {
  if (!iso) return '—';
  let diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '—';
  if (diff < 0) diff = 0;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const fmt = (n) => new Intl.NumberFormat().format(n);

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove('show'), 1800);
}

function setStatus(kind, text) {
  els.statusDot.className = `dot ${kind}`;
  els.statusText.textContent = text;
}

const ICONS = ['★', '◈', '⬢', '✦', '◎', '✧', '◆', '▲'];
const ACCENTS = ['#ff9f43', '#4d8dff', '#2ee6c8', '#ff5da2', '#a66bff', '#3ddc97', '#ffd166', '#00d4ff'];

// ---------------- rendering ----------------
// District population data is NOT published by the worker's snapshot (raw
// config never leaves the worker), so the expandable only renders if/when the
// snapshot ever carries it.
function districtList(d) {
  const cfg = d.config || {};
  const src = cfg.district_populations || cfg.districts || d.district_populations || null;
  if (!src) return null;
  const entries = Array.isArray(src) ? src : Object.entries(src);
  if (!entries.length) return null;
  return entries.map((e) => (Array.isArray(e) ? e : [e.name ?? 'district', e.count ?? 0]));
}

function serverRow(d) {
  const p = Number(d.player_count) || 0;
  const districts = districtList(d);
  return `
    <div class="server-card">
      <div class="server-row">
        <div class="server-name">${esc(d.deployment_name)}</div>
        <div class="server-info">${d.online ? `${fmt(p)} players` : 'offline'}</div>
        <div class="server-icons">
          <span class="status-icon ${d.online ? 'online' : 'offline'}" title="${d.online ? 'Online' : 'Offline'}">●</span>
        </div>
      </div>
      ${districts ? `
        <div class="server-populations">
          <details>
            <summary>${districts.length} populated district${districts.length === 1 ? '' : 's'}</summary>
            <ul>${districts.map(([name, n]) => `<li>${esc(name)}: <strong>${fmt(n)}</strong></li>`).join('')}</ul>
          </details>
        </div>` : ''}
    </div>`;
}

function renderStations() {
  if (!state.stations.length) {
    els.stationList.innerHTML = `<div class="muted-block">${
      state.error ? 'API unreachable — no station data.' : 'Loading…'}</div>`;
    return;
  }

  els.stationList.innerHTML = state.stations
    .map((s, i) => {
      const deps = s.deployments ?? [];
      const online = deps.filter((d) => d.online);
      const players = online.reduce((n, d) => n + (Number(d.player_count) || 0), 0);
      const accent = ACCENTS[i % ACCENTS.length];
      const open = state.openStation === s.station_id;

      const widget = `
        <a class="widget-link" data-station="${esc(s.station_id)}">
          <div class="widget ${open ? 'open' : ''}" style="border-left: 5px solid ${accent}">
            <div class="pfp" style="background:${accent}">${ICONS[i % ICONS.length]}</div>
            <div class="profile">
              <h3>${esc(s.station_name)}</h3>
              <p class="widget-players">${fmt(players)} players online in ${online.length} station${online.length === 1 ? '' : 's'}</p>
            </div>
          </div>
        </a>`;

      if (!open) return widget;

      // group deployments by region -> collapsible region groups (like reference)
      const groups = {};
      deps.forEach((d) => { const r = d.region || 'Unknown'; (groups[r] ||= []).push(d); });

      const detail = `
        <div class="station-detail" style="border-left: 5px solid ${accent}">
          ${Object.entries(groups).map(([region, list]) => `
            <details class="region-group" open>
              <summary>${esc(region)}</summary>
              <div class="server-list">
                ${list.map((d) => serverRow(d)).join('')}
              </div>
            </details>`).join('')}
        </div>`;

      return widget + detail;
    })
    .join('');
}

function renderFooter() {
  els.lastUpdated.textContent = state.lastUpdated ? `updated ${state.lastUpdated.toLocaleTimeString()}` : 'never';
}

function renderAll() {
  els.total.textContent = fmt(totalPlayers());
  renderStations();
  renderFooter();
  drawChart();
}

/* =========================================================================
   Chart (vanilla canvas) — plots the history this page has recorded
   ========================================================================= */
function rangeSamples() {
  const cutoff = Date.now() - RANGE_MS[state.range];
  return state.history.filter((s) => s.t >= cutoff);
}

function drawChart() {
  const cv = els.chart;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const pad = { l: 54, r: 16, t: 16, b: 34 };
  const cw = w - pad.l - pad.r, ch = h - pad.t - pad.b;
  const data = rangeSamples();

  els.rangeStats.textContent = data.length > 1
    ? `${data.length} samples · low ${fmt(Math.min(...data.map(d => d.v)))} · high ${fmt(Math.max(...data.map(d => d.v)))}`
    : 'history from the watcher — waiting for more samples';

  if (data.length < 2) {
    ctx.fillStyle = '#9fb0cd';
    ctx.font = '12px "Source Code Pro", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Collecting data — waiting on the watcher to build history', w / 2, h / 2);
    return;
  }

  const t0 = data[0].t, t1 = data[data.length - 1].t || t0 + 1;
  const span = Math.max(1, t1 - t0);
  const vmax = Math.max(...data.map(d => d.v));
  const ymax = Math.max(10, Math.ceil((vmax * 1.15) / 10) * 10);

  const X = (t) => pad.l + ((t - t0) / span) * cw;
  const Y = (v) => pad.t + ch - (v / ymax) * ch;

  // grid + y labels
  ctx.font = '9px "Source Code Pro", monospace';
  ctx.textBaseline = 'middle';
  const ySteps = 5;
  for (let i = 0; i <= ySteps; i++) {
    const v = (ymax / ySteps) * i;
    const y = Y(v);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillStyle = '#9fb0cd';
    ctx.textAlign = 'right';
    ctx.fillText(fmt(Math.round(v)), pad.l - 10, y);
  }

  // x labels
  ctx.textAlign = 'center';
  const xTicks = Math.max(3, Math.min(10, Math.floor(cw / 90)));
  for (let i = 0; i <= xTicks; i++) {
    const t = t0 + (span / xTicks) * i;
    const d = new Date(t);
    const label = state.range === '24h'
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    ctx.fillStyle = '#9fb0cd';
    ctx.fillText(label, X(t), h - pad.b / 2);
  }

  // area fill
  const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ch);
  grad.addColorStop(0, 'rgba(46,230,200,0.30)');
  grad.addColorStop(1, 'rgba(46,230,200,0.00)');
  ctx.beginPath();
  data.forEach((d, i) => (i ? ctx.lineTo(X(d.t), Y(d.v)) : ctx.moveTo(X(d.t), Y(d.v))));
  ctx.lineTo(X(t1), pad.t + ch); ctx.lineTo(X(t0), pad.t + ch); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  // line
  ctx.beginPath();
  data.forEach((d, i) => (i ? ctx.lineTo(X(d.t), Y(d.v)) : ctx.moveTo(X(d.t), Y(d.v))));
  ctx.strokeStyle = '#2ee6c8';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(46,230,200,0.8)';
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // end marker
  const last = data[data.length - 1];
  ctx.beginPath(); ctx.arc(X(last.t), Y(last.v), 4, 0, Math.PI * 2);
  ctx.fillStyle = '#2ee6c8'; ctx.fill();
  ctx.strokeStyle = '#0a1020'; ctx.lineWidth = 2; ctx.stroke();

  drawChart._geo = { X, Y, data, pad, cw, ch };
}

function onChartMove(e) {
  const geo = drawChart._geo;
  if (!geo) return;
  const rect = els.chart.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const { X, Y, data } = geo;
  let best = data[0], bd = Infinity;
  for (const d of data) { const dd = Math.abs(X(d.t) - mx); if (dd < bd) { bd = dd; best = d; } }
  if (bd > 40) { els.chartTip.hidden = true; return; }
  els.chartTip.hidden = false;
  els.chartTip.style.left = `${X(best.t)}px`;
  els.chartTip.style.top = `${Y(best.v)}px`;
  els.chartTip.textContent = `${fmt(best.v)} players · ${new Date(best.t).toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
}

// ---------------- wiring ----------------
els.stationList.addEventListener('click', (e) => {
  const card = e.target.closest('[data-station]'); if (!card) return;
  const id = card.dataset.station;
  state.openStation = state.openStation === id ? null : id;
  renderStations();
});

els.rangeToggle.addEventListener('click', (e) => {
  const b = e.target.closest('.graph-toggle-btn'); if (!b) return;
  state.range = b.dataset.range;
  els.rangeToggle.querySelectorAll('.graph-toggle-btn').forEach((x) => x.classList.toggle('active', x === b));
  drawChart();
});

els.chart.addEventListener('mousemove', onChartMove);
els.chart.addEventListener('mouseleave', () => (els.chartTip.hidden = true));
window.addEventListener('resize', drawChart);

setInterval(() => {
  if (els.auto.checked && Date.now() >= state.nextRefreshAt) refresh();
  const left = Math.max(0, Math.ceil((state.nextRefreshAt - Date.now()) / 1000));
  els.countdown.textContent = els.auto.checked ? `· next in ${left}s` : '';
  if (state.lastUpdated) renderFooter();
}, 1000);

(async function boot() {
  // Prefer real server-side history (collect.py). Fall back to whatever this
  // browser recorded locally, then let refresh() fill in the live numbers.
  const fromServer = await loadHistoryFromServer();
  if (fromServer && fromServer.length) {
    state.history = fromServer;
    state.historyFromServer = true;
  } else {
    state.history = loadHistory();
  }
  renderAll();
  refresh();
})();

/* =========================================================================
   OPS panels — fed by the watcher worker's own /api/* routes.
   If KV is still warming up (no cron tick yet) the panels show a hint
   instead of breaking the rest of the page.
   ========================================================================= */
const OPS_REFRESH_MS = 60_000;
const opsEls = {
  feed: $('feedList'),
  patches: $('patchList'),
  patchRollout: $('patchRollout'),
  restartStats: $('restartStats'),
  restartBars: $('restartBars'),
  restarts: $('restartList'),
  config: $('configList'),
  rosterBox: $('rosterBox'),
  peakGrid: $('peakGrid'),
  peakDays: $('peakDays'),
  peakBest: $('peakBest'),
  advice: $('adviceLine'),
  regionOptions: $('regionOptions'),
  regions: $('regionList'),
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Compact seconds → "45s" / "5m" / "1h 5m". */
function durShort(sec) {
  if (!Number.isFinite(sec)) return '—';
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return m % 60 ? `${m}m ${m % 60}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

async function opsGet(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function feedItem(ev) {
  const t = new Date(ev.t);
  const when = Number.isNaN(t.getTime()) ? '' : t.toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  return `
    <div class="feed-item t-${esc(ev.type)}">
      <div class="feed-title">${esc(ev.title)}</div>
      ${ev.body ? `<div class="feed-body">${esc(ev.body)}</div>` : ''}
      <div class="feed-time">${esc(when)}</div>
    </div>`;
}

function regionLine(r) {
  return `
    <div class="region-line">
      <span>${r.online ? '🟢' : '🔴'} <strong>${esc(r.code)}</strong></span>
      <span class="rl-pop">${r.online ? `${fmt(r.pop)} players · ${r.online}/${r.servers} up` : `${r.servers} server${r.servers === 1 ? '' : 's'} offline`}</span>
    </div>`;
}

function renderPeak({ cells, by_day, weekend, weekday }) {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (!cells || !cells.length) {
    opsEls.peakGrid.innerHTML = '';
    opsEls.peakBest.textContent = 'Collecting samples — check back in an hour.';
    return;
  }
  const maxAvg = Math.max(...cells.map((c) => c.avg), 1);
  const byKey = new Map(cells.map((c) => [`${c.dow}_${c.hour}`, c]));
  let html = `<span class="pg-label"></span>` +
    Array.from({ length: 24 }, (_, h) =>
      `<span class="pg-hour">${h % 6 === 0 ? String(h).padStart(2, '0') : ''}</span>`).join('');
  for (let d = 0; d < 7; d++) {
    html += `<span class="pg-label">${DAYS[d]}</span>`;
    for (let h = 0; h < 24; h++) {
      const c = byKey.get(`${d}_${h}`);
      const lvl = c ? Math.min(4, Math.ceil((c.avg / maxAvg) * 4)) : 0;
      const tip = c ? `${DAYS[d]} ${String(h).padStart(2, '0')}:00 UTC — avg ${fmt(c.avg)}, peak ${fmt(c.max)}` : '';
      html += `<span class="pg-cell" data-lvl="${lvl}" title="${esc(tip)}"></span>`;
    }
  }
  opsEls.peakGrid.innerHTML = html;
  opsEls.peakBest.textContent = '';

  // Day-of-week rollup under the matrix + weekend/weekday comparison.
  renderDayBars(opsEls.peakDays, by_day, { mode: 'avg' });
  if (by_day && by_day.length && weekend && weekday && weekend.n && weekday.n) {
    const diff = weekend.avg - weekday.avg;
    opsEls.peakDays.insertAdjacentHTML('beforeend',
      `<div class="rollout-line sub">Weekend avg <strong>${fmt(weekend.avg)}</strong> vs weekday ` +
      `<strong>${fmt(weekday.avg)}</strong> (${diff >= 0 ? '+' : ''}${fmt(diff)} players)</div>`);
  }
}

function renderPeakBest(best) {
  if (!best || !best.length) return;
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  opsEls.peakBest.innerHTML =
    'Best times: ' + best.slice(0, 3).map((c) =>
      `<strong>${DAYS[c.dow]} ${String(c.hour).padStart(2, '0')}:00</strong> (avg ${fmt(c.avg)})`
    ).join(' · ');
}

function renderRestartStats(s) {
  if (!s) { opsEls.restartStats.innerHTML = ''; return; }

  const parts = [
    `24h: <strong>${fmt(s.last_24h)}</strong>`,
    `7d: <strong>${fmt(s.last_7d)}</strong>`,
    `avg downtime <strong>${s.avg_downtime_s != null ? durShort(s.avg_downtime_s) : '—'}</strong>`,
    s.mtbf_h != null ? `MTBF <strong>${s.mtbf_h}h</strong>` : null,
    `<strong>${s.restarts_per_day}/day</strong>`,
  ].filter(Boolean);

  let html = parts.join(' · ');
  const w = s.stale_warnings;
  if (w && w.fired) {
    const pct = w.hit_rate != null ? Math.round(w.hit_rate * 100) : 0;
    const lead = w.median_lead_s != null ? durShort(w.median_lead_s) : '—';
    html += `<br><span class="sub">⏱ stale-heartbeat warnings: <strong>${w.fired}</strong> fired → ` +
      `<strong>${w.predicted}</strong> became real (${pct}%, ${lead} of early warning)</span>`;
  }
  opsEls.restartStats.innerHTML = html;
  renderDayBars(opsEls.restartBars, s.by_day, { mode: 'count' });
}

/**
 * Horizontal bar list. Used for two different rollups:
 *   mode 'count' → [{day, n}]            restarts per calendar day
 *   mode 'avg'   → [{dow, avg, n, max}]  average players by day of week
 */
function renderDayBars(el, rows, { mode }) {
  if (!rows || !rows.length) { el.innerHTML = ''; return; }
  const value = (r) => (mode === 'avg' ? r.avg : r.n);
  const label = (r) => (mode === 'avg' ? WEEKDAYS[r.dow] : r.day.slice(5));
  const max = Math.max(...rows.map(value), 1);

  el.innerHTML = rows.map((r) => {
    const v = value(r);
    const text = mode === 'avg' ? `avg ${fmt(v)} · ${fmt(r.n)}` : fmt(v);
    const pct = Math.max(2, Math.round((v / max) * 100));
    return `
      <div class="bar-row">
        <span class="bar-label">${esc(label(r))}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
        <span class="bar-val">${esc(text)}</span>
      </div>`;
  }).join('');
}

/** Build-per-region rollout strip + patch cadence. */
function renderRollout(r, s) {
  if (!r || !r.newest_build) {
    opsEls.patchRollout.innerHTML = '';
    return;
  }
  const chips = Object.entries(r.regions || {})
    .map(([code, b]) =>
      `<span class="chip ${b === r.newest_build ? 'ok' : 'old'}">${esc(code)} ${esc(b)}</span>`)
    .join('');

  const status = r.rollout_complete
    ? '<span class="chip ok">rollout complete</span>'
    : `<span class="chip warn">${r.lagging.length} behind: ${esc(r.lagging.join(', '))}</span>`;

  const cadence = s && s.median_interval_h != null
    ? ` · median ${s.median_interval_h}h between builds`
    : '';
  const recent = s && s.last_7d ? ` · ${s.last_7d} in the last 7d` : '';

  opsEls.patchRollout.innerHTML =
    `<div class="rollout-line">Newest build <strong>${esc(r.newest_build)}</strong> ${status}${cadence}${recent}</div>` +
    `<div class="chip-row">${chips}</div>`;
}

/** Live whitelists + recent join/leave movement (the tournament signal). */
function renderRoster(roster, changes) {
  const keys = Object.keys(roster || {});
  if (!keys.length) {
    opsEls.rosterBox.innerHTML = '<span class="muted-block">No whitelist published yet.</span>';
    return;
  }

  const rows = keys.map((k) => {
    const [where, path] = k.split(':');
    const key = path ? path.split('/').pop() : k;
    const names = roster[k] || [];
    return `
      <div class="roster-row">
        <span class="roster-where">${esc(where)}</span>
        <span class="roster-names">${names.length ? esc(names.join(', ')) : '<em>empty</em>'}</span>
        <span class="roster-key">${esc(key)}</span>
      </div>`;
  }).join('');

  const total = Object.values(roster).reduce((n, list) => n + (list ? list.length : 0), 0);
  const head = `<div class="roster-head">Live roster — ${keys.length} list${keys.length === 1 ? '' : 's'}, ${fmt(total)} name${total === 1 ? '' : 's'}</div>`;

  const moves = (changes || []).slice(0, 3).map((c) => {
    const bits = [];
    if (c.added && c.added.length) bits.push(`<span class="add">+${esc(c.added.join(', '))}</span>`);
    if (c.removed && c.removed.length) bits.push(`<span class="rem">−${esc(c.removed.join(', '))}</span>`);
    if (!bits.length) return '';
    const when = new Date(c.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `<div class="roster-move">${bits.join(' ')} <span class="muted-inline">${esc(when)}</span></div>`;
  }).filter(Boolean).join('');

  opsEls.rosterBox.innerHTML = head + rows + moves;
}

/** Scored region shortlist: geo match + population + server health. */
function renderRegionOptions(options) {
  if (!options || options.length < 2) {
    opsEls.regionOptions.innerHTML = '';
    return;
  }
  opsEls.regionOptions.innerHTML = options.slice(0, 5).map((o, i) => `
    <div class="opt-row${o.home ? ' home' : ''}">
      <span class="opt-rank">${i + 1}</span>
      <span class="opt-code">${esc(o.code)}</span>
      <span class="opt-why">${esc(o.why)}</span>
      <span class="opt-score" title="geo + population + health score">${o.score}</span>
    </div>`).join('');
}

let opsLoadedOnce = false;

async function refreshOps() {
  const hint = (el, msg) => { if (!opsLoadedOnce) el.innerHTML = `<div class="muted-block">${msg}</div>`; };
  try {
    const [ev, pt, rs, cf, pk, st] = await Promise.all([
      opsGet('/api/events?limit=15'),
      opsGet('/api/patches?limit=8'),
      opsGet('/api/restarts?limit=8'),
      opsGet('/api/config?limit=8'),
      opsGet('/api/peak'),
      opsGet('/api/state'),   // the worker geo-locates the caller itself
    ]);

    opsEls.feed.innerHTML = ev.events.length
      ? ev.events.map(feedItem).join('')
      : '<div class="muted-block">No events yet — the watcher is still learning.</div>';

    opsEls.patches.innerHTML = pt.patches.length
      ? pt.patches.map(feedItem).join('')
      : '<div class="muted-block">No build bumps observed yet.</div>';
    renderRollout(pt.rollout, pt.stats);

    renderRestartStats(rs.stats);
    opsEls.restarts.innerHTML = rs.restarts.length
      ? rs.restarts.map(feedItem).join('')
      : '<div class="muted-block">No restarts observed yet.</div>';

    opsEls.config.innerHTML = cf.changes.length
      ? cf.changes.map(feedItem).join('')
      : '<div class="muted-block">No config drift observed yet.</div>';
    renderRoster(cf.roster, cf.whitelist_changes);

    renderPeak(pk);
    renderPeakBest(pk.best_hours);

    const regions = Object.values(st.regions || {}).sort((a, b) => b.pop - a.pop);
    opsEls.regions.innerHTML = regions.length
      ? regions.map(regionLine).join('')
      : '<div class="muted-block">No region data yet.</div>';
    if (st.advice) {
      opsEls.advice.innerHTML = st.advice.recommended
        ? `Your continent <strong>${esc(st.advice.continent)}</strong> → play <strong>${esc(st.advice.recommended)}</strong>. ${esc(st.advice.reason)}`
        : esc(st.advice.reason || '');
      renderRegionOptions(st.advice.options);
    } else {
      opsEls.advice.textContent = '';
      renderRegionOptions(null);
    }
    opsLoadedOnce = true;
  } catch {
    // Worker unreachable (or KV empty on the very first tick).
    hint(opsEls.feed, 'Watcher data unavailable — waiting on the first cron tick.');
    hint(opsEls.patches, 'Watcher data unavailable.');
    hint(opsEls.restarts, 'Watcher data unavailable.');
    hint(opsEls.config, 'Watcher data unavailable.');
    hint(opsEls.rosterBox, 'Watcher data unavailable.');
    if (!opsLoadedOnce) {
      opsEls.peakBest.textContent = 'Watcher data unavailable.';
      opsEls.regions.innerHTML = '<div class="muted-block">Watcher data unavailable.</div>';
    }
  }
}

refreshOps();
setInterval(refreshOps, OPS_REFRESH_MS);
