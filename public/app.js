const HR_GUIDE = 148;

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmtDay = (d) => new Date(d + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const fmtShort = (d) => new Date(d + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" });
const hm = (s) => (s == null ? "—" : `${Math.floor(s / 3600)}h${String(Math.round((s % 3600) / 60)).padStart(2, "0")}`);
const today = () => new Date().toLocaleDateString("en-CA");

function table(headers, rows) {
  if (!rows.length) return '<span class="muted">No data yet.</span>';
  return `<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function lineChart(id, labels, datasets, axes) {
  new Chart(document.getElementById(id), {
    type: "line",
    data: { labels, datasets: datasets.map((d) => ({ tension: 0.15, pointRadius: 3, backgroundColor: "transparent", spanGaps: true, ...d })) },
    options: { responsive: true, maintainAspectRatio: false, scales: axes },
  });
}

function renderSyncStatus(syncs) {
  if (!syncs.length) return "No syncs have run yet.";
  return syncs.map((s) => {
    const when = new Date(s.started_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
    return `<span class="${s.ok ? "" : "sync-bad"}" title="${esc(s.message)}">${esc(s.source)} ${s.ok ? "✓" : "✗"} ${when}</span>`;
  }).join(" · ");
}

function renderCards({ health, weights }) {
  const last = (key) => [...health].reverse().find((h) => h[key] != null);
  const w = weights.at(-1);
  const weekAgo = w && [...weights].reverse().find((x) => new Date(x.measured_at) <= new Date(new Date(w.measured_at) - 6 * 86_400_000));
  const card = (label, row, key, unit, detail) =>
    `<div class="card"><div class="label">${label}</div><div class="value">${row ? row[key] + unit : "—"}</div><div class="detail">${row ? detail(row) : "no data"}</div></div>`;
  document.getElementById("cards").innerHTML = [
    card("Resting HR", last("resting_hr"), "resting_hr", "", (r) => fmtDay(r.date)),
    card("Overnight HRV", last("hrv_last_night"), "hrv_last_night", " ms", (r) => `${esc(r.hrv_status ?? "")} · ${fmtDay(r.date)}`),
    card("Readiness", last("readiness_score"), "readiness_score", "", (r) => `${esc(r.readiness_level ?? "")} · ${fmtDay(r.date)}`),
    card("Sleep score", last("sleep_score"), "sleep_score", "", (r) => `${hm(r.sleep_s)} · ${fmtDay(r.date)}`),
    card("Weight", w, "weight_kg", " kg", (r) => (weekAgo ? `${(r.weight_kg - weekAgo.weight_kg).toFixed(1)} kg vs a week earlier` : fmtShort(r.measured_at.slice(0, 10)))),
  ].join("");
}

function renderNote(note) {
  if (!note) return;
  document.getElementById("noteTitle").textContent = `Coach's note — ${fmtDay(note.date)}`;
  document.getElementById("note").textContent = note.body;
}

function renderRecoveryCharts(health) {
  const labels = health.map((h) => fmtShort(h.date));
  lineChart("hrvChart", labels, [
    { label: "Resting HR", data: health.map((h) => h.resting_hr), borderColor: "#b3261e", yAxisID: "y" },
    { label: "HRV (ms)", data: health.map((h) => h.hrv_last_night), borderColor: "#2a6fdb", yAxisID: "y1" },
  ], { y: { position: "left" }, y1: { position: "right", grid: { drawOnChartArea: false } } });
  lineChart("readinessChart", labels, [
    { label: "Readiness", data: health.map((h) => h.readiness_score), borderColor: "#1e7a34", yAxisID: "y" },
    { label: "Acute load", data: health.map((h) => h.acute_load), borderColor: "#999", borderDash: [4, 3], yAxisID: "y1" },
  ], { y: { position: "left", min: 0, max: 100 }, y1: { position: "right", grid: { drawOnChartArea: false } } });
}

function renderPlan({ weeks, days }) {
  if (!weeks.length) return (document.getElementById("planTable").innerHTML = '<span class="muted">No plan imported yet.</span>');
  let i = weeks.findIndex((w) => today() >= w.start_date && today() <= w.end_date);
  if (i === -1) i = weeks.length - 1;

  const show = () => {
    const w = weeks[i];
    document.getElementById("weekTitle").textContent = `${w.label} (${fmtShort(w.start_date)} – ${fmtShort(w.end_date)})`;
    document.getElementById("weekTotal").textContent = w.planned_total_km != null ? `Planned: ${w.planned_total_km} km` : "";
    document.getElementById("prevWeek").disabled = i === 0;
    document.getElementById("nextWeek").disabled = i === weeks.length - 1;
    const rows = days.filter((d) => d.week_start === w.start_date).map((d) => [
      fmtDay(d.date),
      esc(d.gym ?? "—"),
      d.run_type ? `<span class="pill pill-type">${esc(d.run_type)}</span>` : "—",
      d.planned_km != null ? `${d.planned_km} km` : "—",
      d.actual_km != null ? `${d.actual_km} km` : "—",
      `<span class="pill pill-${d.status}">${d.status}</span> ${esc(d.notes ?? "")}`,
    ]);
    document.getElementById("planTable").innerHTML = table(["Day", "Gym", "Run", "Planned", "Actual", "Notes"], rows);
  };
  document.getElementById("prevWeek").onclick = () => { i--; show(); };
  document.getElementById("nextWeek").onclick = () => { i++; show(); };
  show();

  const actual = weeks.map((w) => days.filter((d) => d.week_start === w.start_date).reduce((sum, d) => sum + (d.actual_km ?? 0), 0));
  new Chart(document.getElementById("volumeChart"), {
    type: "bar",
    data: {
      labels: weeks.map((w) => w.label.replace("Week ", "W")),
      datasets: [
        { label: "Planned", data: weeks.map((w) => w.planned_total_km), backgroundColor: "#c9d6ee" },
        { label: "Actual", data: actual, backgroundColor: "#2a6fdb" },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true } } },
  });
}

function renderRuns(runs) {
  lineChart("hrTrendChart", runs.map((r) => fmtShort(r.date)), [
    { label: "Avg HR", data: runs.map((r) => r.avg_hr), borderColor: "#b3261e", yAxisID: "y", pointRadius: 4 },
    { label: "Easy guide", data: runs.map(() => HR_GUIDE), borderColor: "#1e7a34", borderDash: [2, 2], pointRadius: 0, yAxisID: "y" },
    { label: "Distance (km)", data: runs.map((r) => r.distance_km), borderColor: "#999", borderDash: [4, 3], yAxisID: "y1" },
  ], { y: { position: "left" }, y1: { position: "right", grid: { drawOnChartArea: false } } });
}

function renderWeight(weights) {
  lineChart("weightChart", weights.map((w) => fmtShort(w.measured_at.slice(0, 10))), [
    { label: "Weight (kg)", data: weights.map((w) => w.weight_kg), borderColor: "#6b4fbb", yAxisID: "y" },
  ], { y: { position: "left" } });
}

function renderGym(gym) {
  document.getElementById("gymTable").innerHTML = table(["Date", "Session", "Exercises"], gym.map((g) => [
    fmtDay(g.date),
    esc(g.name ?? ""),
    esc((g.exercises ?? []).map((e) => e.name).join(", ")),
  ]));
}

function renderActivities(recent) {
  document.getElementById("activityTable").innerHTML = table(["When", "Type", "Distance", "Time", "Avg / max HR", "Effect"], recent.map((a) => [
    `${fmtDay(a.date)} ${a.start_local.slice(11, 16)}`,
    esc(a.type),
    a.distance_km ? `${a.distance_km} km` : "—",
    hm(a.duration_s),
    a.avg_hr ? `<span class="${a.type === "running" && a.avg_hr > HR_GUIDE ? "hot" : ""}">${a.avg_hr}</span> / ${a.max_hr ?? "—"}` : "—",
    esc(a.training_effect_label ?? ""),
  ]));
}

function renderSleep(health) {
  document.getElementById("sleepTable").innerHTML = table(["Night", "Score", "Total", "Deep", "Light", "REM", "Awake"],
    health.slice(-7).reverse().map((h) => [fmtDay(h.date), h.sleep_score ?? "—", hm(h.sleep_s), hm(h.deep_s), hm(h.light_s), hm(h.rem_s), hm(h.awake_s)]));
}

async function main() {
  const res = await fetch("/api/dashboard");
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  const data = await res.json();
  document.getElementById("syncStatus").innerHTML = renderSyncStatus(data.syncs);
  renderCards(data);
  renderNote(data.note);
  renderRecoveryCharts(data.health);
  renderPlan(data);
  renderRuns(data.runs);
  renderWeight(data.weights);
  renderGym(data.gym);
  renderActivities(data.recent);
  renderSleep(data.health);
}

main().catch((err) => (document.getElementById("syncStatus").textContent = `Couldn't load: ${err.message}`));
