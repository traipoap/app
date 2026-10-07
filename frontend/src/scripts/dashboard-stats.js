// ─────────────────────────────────────────────────────────────────────────────
// LUMINA — Dashboard (stats) page script
//
// ทุกตัวเลขมาจาก query จริงต่อ Quickwit ผ่าน backend /api/search:
//   • Total Logs, Logs Over Time (24 buckets)  → count queries (max_hits=0, total ถูกต้อง)
//   • Errors / Warnings / Error Rate / Sources → sample จาก 500 logs ล่าสุดใน range
//     (backend ยังไม่ expose aggregation group-by จึงใช้ sample แทน)
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE = "";

// ── Auth helpers (same-origin /api/*) ────────────────────────────────────────
function getToken() {
  return (
    window.sessionStorage.getItem("authToken") ||
    window.localStorage.getItem("authToken")
  );
}

function clearTokens() {
  window.localStorage.removeItem("authToken");
  window.sessionStorage.removeItem("authToken");
}

function getRefreshToken() {
  return (
    window.sessionStorage.getItem("refreshToken") ||
    window.localStorage.getItem("refreshToken")
  );
}

async function tryRefreshToken() {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  try {
    const res = await fetch(`${API_BASE}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) {
      clearTokens();
      window.location.href = "/signin";
      return false;
    }
    const data = await res.json();
    if (data.access_token) {
      window.localStorage.setItem("authToken", data.access_token);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function authenticatedFetch(url, options = {}) {
  const token = getToken();
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
  if (res.status === 401) {
    const refreshed = await tryRefreshToken();
    if (refreshed) {
      const newToken = getToken();
      return fetch(url, {
        ...options,
        headers: {
          ...(options.headers || {}),
          Authorization: `Bearer ${newToken}`,
        },
      });
    }
  }
  return res;
}

// ── Toast ────────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(message, isError = false) {
  const toast = document.getElementById("toast");
  const msg = document.getElementById("toastMessage");
  if (!toast || !msg) return;
  msg.textContent = message;
  toast.classList.toggle("toast-error", isError);
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

// ── State ────────────────────────────────────────────────────────────────────
const RANGES = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};
let rangeKey = "24h";
let indexId = "";
let loading = false;

function rangeTimes() {
  const to = Date.now();
  const from = to - (RANGES[rangeKey] || RANGES["24h"]);
  return [from, to];
}

// ── API calls ────────────────────────────────────────────────────────────────
async function apiSearch(params) {
  const res = await authenticatedFetch(`${API_BASE}/api/search?${params.toString()}`);
  if (res.status === 403) {
    clearTokens();
    window.location.href = "/signin";
    throw new Error("unauthorized");
  }
  if (!res.ok) throw new Error(`Server error ${res.status}`);
  return res.json();
}

// Count query — ต้องการแค่ total (max_hits=0)
async function countQuery(from, to, rawQuery = null) {
  const params = new URLSearchParams({
    index_id: indexId,
    from_timestamp: String(from),
    to_timestamp: String(to),
    max_hits: 0,
  });
  if (rawQuery) params.set("raw_query", rawQuery);
  const data = await apiSearch(params);
  return Number(data.total || 0);
}

// Sample query — ดึง hits ≤ 500 สำหรับ breakdown ระดับ/แหล่งที่มา
async function fetchSample(from, to) {
  const params = new URLSearchParams({
    index_id: indexId,
    from_timestamp: String(from),
    to_timestamp: String(to),
    max_hits: 500,
  });
  const data = await apiSearch(params);
  return (data.hits || []).map(mapHit);
}

function mapHit(hit) {
  // Timestamp: รองรับ s / ms / µs / ns
  const tsRaw =
    hit.timestamp ??
    hit.timeUnixNano ??
    hit.time_unix_nano ??
    hit.start ??
    hit.index_timestamp;
  let ts = Number(tsRaw);
  if (!isFinite(ts) || ts <= 0) ts = Date.now();
  if (ts > 1e17) ts = Math.floor(ts / 1e6); // ns → ms
  else if (ts > 1e14) ts = Math.floor(ts / 1e3); // µs → ms
  else if (ts < 1e11) ts = Math.floor(ts * 1000); // s → ms
  return {
    timestamp: new Date(ts),
    level: String(hit.level || hit.severity || hit.severityText || hit.status || "info").toLowerCase(),
    source: hit.source_ip || hit.source || hit.service || hit["service.name"] || "unknown",
    host: hit.host || hit.hostname || hit["k8s.node_name"] || "",
    message: hit.message || hit.body || "",
  };
}

// ── Load & render ────────────────────────────────────────────────────────────
const LEVEL_COLORS = {
  error: "var(--danger)",
  warn: "var(--warning)",
  warning: "var(--warning)",
  info: "var(--accent-2)",
  debug: "var(--accent-purple)",
  critical: "#dc2626",
  trace: "var(--faint)",
};

async function loadDashStats() {
  const select = document.getElementById("dashIndex");
  if (!select || !select.value) {
    showToast("No index selected", true);
    return;
  }
  if (loading) return;
  loading = true;
  indexId = select.value;
  const btn = document.getElementById("dashRefresh");
  if (btn) btn.disabled = true;

  const [from, to] = rangeTimes();

  try {
    // 1) Total — count query (ถูกต้องตามจำนวนจริง)
    const total = await countQuery(from, to);
    setEl("dashTotal", total.toLocaleString());

    // 2) Time series — 24 buckets ของ count queries
    const BUCKETS = 24;
    const span = to - from;
    const bucketSize = span / BUCKETS;
    const bucketCounts = await Promise.all(
      Array.from({ length: BUCKETS }, (_, i) =>
        countQuery(from + i * bucketSize, from + (i + 1) * bucketSize)
      )
    );
    renderTimeChart(bucketCounts, from, bucketSize);
    renderPeak(bucketCounts, from, bucketSize);

    // 3) Sample ≤ 500 — ระดับ / error rate / sources
    const sample = await fetchSample(from, to);
    renderSample(sample);

    showToast(`Dashboard updated — ${total.toLocaleString()} logs in range`);
  } catch (err) {
    console.error("Dashboard stats error:", err);
    if (err.message !== "unauthorized") showToast("Failed to load dashboard stats", true);
  } finally {
    loading = false;
    if (btn) btn.disabled = false;
  }
}

function setEl(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function renderTimeChart(bucketCounts, from, bucketSize) {
  const max = Math.max(...bucketCounts, 1);
  const chart = document.getElementById("timeChart");
  if (!chart) return;
  chart.innerHTML = bucketCounts
    .map((count, i) => {
      const height = Math.max(2, (count / max) * 150);
      const t = from + i * bucketSize;
      const label = formatBucketLabel(t);
      return `
        <div class="bar-group">
          <div class="bar" style="height: ${height}px; background: var(--accent);"
               title="${label} — ${count.toLocaleString()} logs"></div>
          <span class="bar-label">${label}</span>
        </div>`;
    })
    .join("");
}

function formatBucketLabel(t) {
  const d = new Date(t);
  if (rangeKey === "1h") {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getHours()).padStart(2, "0")}:00`;
}

function renderPeak(bucketCounts, from, bucketSize) {
  let maxIdx = 0;
  bucketCounts.forEach((c, i) => {
    if (c > bucketCounts[maxIdx]) maxIdx = i;
  });
  const peakCount = bucketCounts[maxIdx];
  if (!peakCount) {
    setEl("dashPeak", "—");
    return;
  }
  const t = new Date(from + maxIdx * bucketSize);
  setEl(
    "dashPeak",
    `${peakCount.toLocaleString()} @ ${formatBucketLabel(t)}`
  );
}

function renderSample(sample) {
  const total = sample.length || 1;
  const counts = {};
  const sources = {};

  sample.forEach((log) => {
    const lvl =
      log.level === "warning" ? "warn" : log.level === "critical" ? "error" : log.level;
    counts[lvl] = (counts[lvl] || 0) + 1;
    if (log.source && log.source !== "unknown") {
      sources[log.source] = (sources[log.source] || 0) + 1;
    }
  });

  const errors = (counts.error || 0) + 0; // error+critical รวมกันแล้ว
  const warns = counts.warn || 0;

  setEl("dashErrors", String(counts.error || 0));
  setEl("dashWarns", String(warns));
  setEl("dashErrorRate", ((errors / total) * 100).toFixed(1) + "%");
  setEl("dashSources", String(Object.keys(sources).length));

  // Level distribution legend
  const legend = document.getElementById("levelLegend");
  if (legend) {
    const levels = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    legend.innerHTML =
      levels.length === 0
        ? '<div class="chart-loading">No logs in range</div>'
        : levels
            .map((level) => {
              const count = counts[level];
              const pct = ((count / total) * 100).toFixed(1);
              const color = LEVEL_COLORS[level] || "var(--muted)";
              return `
                <div class="legend-item">
                  <span class="legend-dot" style="background: ${color};"></span>
                  <span>${level.charAt(0).toUpperCase() + level.slice(1)}</span>
                  <span class="legend-count" style="margin-left: auto;">
                    ${count.toLocaleString()} (${pct}%)
                  </span>
                </div>`;
            })
            .join("");
  }

  // Top sources
  const topSourcesList = document.getElementById("topSourcesList");
  if (topSourcesList) {
    const sorted = Object.entries(sources).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) {
      topSourcesList.innerHTML = '<div class="chart-loading">No sources found</div>';
      return;
    }
    const maxSource = sorted[0][1];
    const palette = [
      "var(--accent)", "var(--accent-2)", "var(--success)",
      "var(--accent-purple)", "var(--warning)", "var(--danger)",
    ];
    topSourcesList.innerHTML = sorted
      .slice(0, 8)
      .map(([source, count], i) => {
        const width = Math.max(4, (count / maxSource) * 100);
        return `
          <div class="source-item">
            <span class="source-name" title="${escapeHtml(source)}">${escapeHtml(source)}</span>
            <div class="source-bar-container">
              <div class="source-bar" style="width: ${width}%; background: ${palette[i % palette.length]};"></div>
            </div>
            <span class="source-count">${count.toLocaleString()}</span>
          </div>`;
      })
      .join("");
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Controls ─────────────────────────────────────────────────────────────────
function setDashRange(key, btn) {
  rangeKey = key;
  document
    .querySelectorAll(".dash-controls .fb-chips .level-btn")
    .forEach((b) => b.classList.toggle("active", b === btn));
  const sub = document.getElementById("dashTotalSub");
  if (sub) sub.textContent = `exact count · last ${key}`;
  loadDashStats();
}

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  const select = document.getElementById("dashIndex");
  if (!select) return;
  try {
    const res = await authenticatedFetch(`${API_BASE}/api/indices`);
    if (res.status === 403) {
      clearTokens();
      window.location.href = "/signin";
      return;
    }
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json();
    const ids = data
      .map((item) => item.index_config?.index_id)
      .filter((id) => id)
      .sort((a, b) => (a === "syslogs" ? -1 : b === "syslogs" ? 1 : 0));
    if (ids.length === 0) {
      select.innerHTML = '<option value="">No indexes found</option>';
      return;
    }
    select.innerHTML = ids.map((id) => `<option value="${id}">${id}</option>`).join("");
    select.addEventListener("change", () => loadDashStats());
    await loadDashStats();
  } catch (err) {
    console.error("Failed to load indexes:", err);
    select.innerHTML = '<option value="">Failed to load indexes</option>';
    showToast("Failed to load indexes", true);
  }
});

// Expose to inline onclick handlers
window.setDashRange = setDashRange;
window.loadDashStats = loadDashStats;
