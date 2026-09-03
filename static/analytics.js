/* ══════════════════════════════════════════════════════════════════════════
   Hygd — Analytics page
   Fetches /api/analytics once, then renders KPIs, Chart.js charts and tables
   for the selected semester bucket. Switching semesters is instant (no refetch).
══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  // Brand-consistent palette (indigo family + supporting hues).
  const INDIGO = "#4f46e5";
  const PALETTE = [
    "#4f46e5", "#7c3aed", "#0ea5e9", "#10b981", "#f59e0b",
    "#ef4444", "#ec4899", "#14b8a6", "#8b5cf6", "#64748b",
    "#22c55e", "#f97316",
  ];
  const GRID = "rgba(148,163,184,.18)";
  const TICK = "#64748b";

  let PAYLOAD = null;      // full /api/analytics response
  let CURRENT = "All";     // selected semester key
  const CHARTS = {};       // canvasId → Chart instance

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (n) => Number(n || 0).toLocaleString();

  // ── Chart.js shared defaults ──────────────────────────────────────────────
  if (window.Chart) {
    Chart.defaults.font.family = "'Segoe UI', system-ui, -apple-system, sans-serif";
    Chart.defaults.color = TICK;
    Chart.defaults.plugins.legend.labels.boxWidth = 12;
    Chart.defaults.plugins.legend.labels.usePointStyle = true;
    Chart.defaults.maintainAspectRatio = false;
  }

  function destroyChart(id) {
    if (CHARTS[id]) { CHARTS[id].destroy(); delete CHARTS[id]; }
  }

  function barChart(id, rows, { horizontal = false, color = INDIGO, label = "Events" } = {}) {
    destroyChart(id);
    const el = $(id);
    if (!el) return;
    const labels = rows.map((r) => r.label);
    const data = rows.map((r) => r.count);
    CHARTS[id] = new Chart(el, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label, data, backgroundColor: color, borderRadius: 6,
          maxBarThickness: 34,
        }],
      },
      options: {
        indexAxis: horizontal ? "y" : "x",
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: GRID, drawBorder: false }, ticks: { precision: 0 } },
          y: { grid: { color: GRID, drawBorder: false }, ticks: { precision: 0 } },
        },
      },
    });
  }

  function doughnut(id, rows) {
    destroyChart(id);
    const el = $(id);
    if (!el) return;
    CHARTS[id] = new Chart(el, {
      type: "doughnut",
      data: {
        labels: rows.map((r) => r.label),
        datasets: [{
          data: rows.map((r) => r.count),
          backgroundColor: rows.map((_, i) => PALETTE[i % PALETTE.length]),
          borderWidth: 2, borderColor: "#fff",
        }],
      },
      options: {
        cutout: "58%",
        plugins: { legend: { position: "right" } },
      },
    });
  }

  function lineChart(id, rows) {
    destroyChart(id);
    const el = $(id);
    if (!el) return;
    CHARTS[id] = new Chart(el, {
      type: "line",
      data: {
        labels: rows.map((r) => r.label),
        datasets: [{
          label: "Events", data: rows.map((r) => r.count),
          borderColor: INDIGO, backgroundColor: "rgba(79,70,229,.12)",
          fill: true, tension: 0.32, pointRadius: 3, pointBackgroundColor: INDIGO,
        }],
      },
      options: {
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: GRID, drawBorder: false } },
          y: { grid: { color: GRID, drawBorder: false }, ticks: { precision: 0 }, beginAtZero: true },
        },
      },
    });
  }

  // ── KPI cards ─────────────────────────────────────────────────────────────
  function renderKpis(k) {
    const cards = [
      { icon: "calendar-event", label: "Total events", value: num(k.total), tone: "indigo" },
      { icon: "check2-circle", label: "Active", value: num(k.active), tone: "green" },
      { icon: "x-octagon", label: "Cancelled",
        value: num(k.cancelled), sub: k.cancel_rate + "% of total", tone: "red" },
      { icon: "collection", label: "Distinct bookings", value: num(k.bookings), tone: "violet" },
      { icon: "people-fill", label: "Total attendance", value: num(k.att_total), tone: "sky" },
      { icon: "person", label: "Avg attendance", value: num(k.att_avg),
        sub: "peak " + num(k.att_peak), tone: "teal" },
      { icon: "geo-alt", label: "Rooms used", value: num(k.rooms),
        sub: k.buildings + " buildings", tone: "amber" },
      { icon: "hourglass-split", label: "Avg duration",
        value: k.dur_avg ? fmtDur(k.dur_avg) : "—", tone: "slate" },
      { icon: "image", label: "With room layouts", value: num(k.with_layout), tone: "pink" },
      { icon: "chat-left-text", label: "With notes", value: num(k.with_notes), tone: "slate" },
    ];
    $("kpi-row").innerHTML = cards.map((c) => `
      <div class="kpi-card kpi-${c.tone}">
        <div class="kpi-icon"><i class="bi bi-${c.icon}"></i></div>
        <div class="kpi-body">
          <div class="kpi-value">${c.value}</div>
          <div class="kpi-label">${esc(c.label)}</div>
          ${c.sub ? `<div class="kpi-sub">${esc(c.sub)}</div>` : ""}
        </div>
      </div>`).join("");
  }

  function fmtDur(mins) {
    const h = Math.floor(mins / 60), m = mins % 60;
    if (h && m) return `${h}h ${m}m`;
    if (h) return `${h}h`;
    return `${m}m`;
  }

  // ── Tables ────────────────────────────────────────────────────────────────
  function fillTable(tbodyId, rows, cols, emptyMsg) {
    const tb = $(tbodyId);
    if (!rows || !rows.length) {
      tb.innerHTML = `<tr><td colspan="${cols.length}" class="an-empty-cell">${esc(emptyMsg || "No data")}</td></tr>`;
      return;
    }
    tb.innerHTML = rows.map((r) => "<tr>" + cols.map((c) => {
      const v = c.get(r);
      return `<td class="${c.num ? "num" : ""}">${c.raw ? v : esc(v)}</td>`;
    }).join("") + "</tr>").join("");
  }

  // ── Render one semester bucket ────────────────────────────────────────────
  function render(key) {
    CURRENT = key;
    const d = PAYLOAD.data[key];
    if (!d) return;

    $("scope-badge").textContent = key + " · " + num(d.kpis.total) + " events";

    // Highlight the active pill
    document.querySelectorAll(".semester-pill").forEach((p) => {
      p.classList.toggle("active", p.dataset.key === key);
    });

    renderKpis(d.kpis);

    doughnut("chart-dept", d.dept);
    barChart("chart-building", d.building, { horizontal: true, color: "#7c3aed" });
    (d.month.length > 1 ? lineChart : (id, r) => barChart(id, r))("chart-month", d.month);
    barChart("chart-weekday", d.weekday, { color: "#0ea5e9" });
    barChart("chart-hour", d.hour, { color: "#10b981" });
    doughnut("chart-service", d.service.length ? d.service : [{ label: "—", count: 0 }]);
    barChart("chart-att", d.att_by_dept, { horizontal: true, color: "#f59e0b", label: "People" });

    fillTable("tbl-items", d.items, [
      { get: (r) => r.label },
      { get: (r) => num(r.count), num: true, raw: true },
      { get: (r) => num(r.qty), num: true, raw: true },
    ], "No setup items recorded");

    fillTable("tbl-rooms", d.room, [
      { get: (r) => r.label },
      { get: (r) => num(r.count), num: true, raw: true },
    ]);

    fillTable("tbl-days", d.busiest_days, [
      { get: (r) => fmtDate(r.label) },
      { get: (r) => num(r.count), num: true, raw: true },
    ]);

    fillTable("tbl-events", d.top_events, [
      { get: (r) => r.name },
      { get: (r) => r.room || "—" },
      { get: (r) => num(r.attendance), num: true, raw: true },
    ], "No attendance figures recorded");

    fillTable("tbl-coord", d.coordinators, [
      { get: (r) => r.label },
      { get: (r) => num(r.count), num: true, raw: true },
    ]);

    fillTable("tbl-onsite", d.onsite, [
      { get: (r) => r.label },
      { get: (r) => num(r.count), num: true, raw: true },
    ]);
  }

  function fmtDate(iso) {
    // 2026-10-14 → Wed, Oct 14
    try {
      const dt = new Date(iso + "T00:00:00");
      return dt.toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric" });
    } catch (e) { return iso; }
  }

  // ── Semester pills ────────────────────────────────────────────────────────
  function renderPills(semesters) {
    $("semester-pills").innerHTML = semesters.map((s) => `
      <button class="semester-pill" data-key="${esc(s.key)}">
        ${esc(s.key)} <span class="pill-count">${num(s.count)}</span>
      </button>`).join("");
    document.querySelectorAll(".semester-pill").forEach((p) => {
      p.addEventListener("click", () => render(p.dataset.key));
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  fetch("/api/analytics")
    .then((r) => r.json())
    .then((payload) => {
      PAYLOAD = payload;
      $("an-loading").classList.add("d-none");

      const total = payload.data.All ? payload.data.All.kpis.total : 0;
      if (!total) {
        $("an-empty").classList.remove("d-none");
        return;
      }
      $("an-content").classList.remove("d-none");
      renderPills(payload.semesters);

      // Default to the newest real semester (first after "All"), else "All".
      const first = payload.semesters.find((s) => s.key !== "All" && s.count > 0);
      render(first ? first.key : "All");
    })
    .catch((err) => {
      $("an-loading").innerHTML =
        `<i class="bi bi-exclamation-triangle text-danger fs-1"></i>
         <p class="text-muted mt-2">Couldn't load analytics: ${esc(err.message)}</p>`;
    });
})();
