/* =========================================================================
   Project Rebirth — Live Statistics
   Backend: Mothership API (https://api.cosmovr.org)

   Public endpoints:
     GET /v1/stations?include_deployments=true&include_config=true&page=&page_size=
     GET /v1/region
     GET /health

   The API only exposes the CURRENT player count, so this page records a
   sample every refresh (localStorage) and charts that history.
   ========================================================================= */

const API_BASE = 'https://api.cosmovr.org';
const REFRESH_MS = 30_000;
const SAMPLE_MS = 60_000;           // one history point per minute max
const HISTORY_KEY = 'pr_player_history_v1';
const MAX_HISTORY = 20_000;

const RANGE_MS = { '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3, '30d': 30 * 24 * 3600e3 };

const state = {
  stations: [],
  region: null,
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
// Preferred source: history.json written by collect.py (real, server-side,
// shared by every visitor). Fallback: localStorage, recorded while the tab
// is open. Set true once we confirm the server file loaded.
state.historyFromServer = false;

async function loadHistoryFromServer() {
  try {
    // cache-bust so we always see the collector's newest samples
    const res = await fetch(`history.json?_=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json();
    const arr = Array.isArray(json) ? json : json?.samples;
    if (!Array.isArray(arr) || !arr.length) return null;
    // keep only well-formed {t,v} points
    return arr.filter((s) => s && Number.isFinite(s.t) && Number.isFinite(s.v));
  } catch {
    return null; // file missing (not running collect.py) or blocked
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
async function fetchStations() {
  const out = [];
  let page = 1, pages = 1;
  do {
    const res = await fetch(
      `${API_BASE}/v1/stations?include_deployments=true&include_config=true&page=${page}&page_size=100`,
      { cache: 'no-store' }
    );
    if (!res.ok) throw new Error(`API returned HTTP ${res.status}`);
    const json = await res.json();
    pages = json.page?.pages ?? 1;
    out.push(...(json.items ?? []));
    page++;
  } while (page <= pages);
  return out;
}

async function fetchRegion() {
  try {
    const r = await fetch(`${API_BASE}/v1/region`, { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  try {
    const [stations, region] = await Promise.all([fetchStations(), fetchRegion()]);
    state.stations = stations;
    state.region = region;
    state.error = null;
    state.lastUpdated = new Date();
    if (state.historyFromServer) {
      // Collector owns history — re-pull it so the chart keeps growing.
      const fresh = await loadHistoryFromServer();
      if (fresh && fresh.length) state.history = fresh;
    } else {
      recordSample(totalPlayers(stations));
    }
    setStatus('live', region ? `${region.continent_code} · ${region.country_code}` : 'live');
  } catch (err) {
    state.error = err.message;
    setStatus(state.stations.length ? 'stale' : 'offline', state.stations.length ? 'stale data' : 'api unreachable');
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
// District population data is NOT published by this API (config comes back
// empty), so the expandable only renders if/when the API exposes it.
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
    : 'history from collector — waiting for more samples';

  if (data.length < 2) {
    ctx.fillStyle = '#9fb0cd';
    ctx.font = '12px "Source Code Pro", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Collecting data — run collect.py to build history', w / 2, h / 2);
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
