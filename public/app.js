const HR_GUIDE = 148;

// ---------- Helpers ----------

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const todayIso = () => new Date().toLocaleDateString("en-CA");
const asDate = (d) => new Date(d.slice(0, 10) + "T00:00:00");
const fmtDay = (d) => asDate(d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const fmtShort = (d) => asDate(d).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const nums = (rows, key) => rows.map((r) => r[key]).filter((v) => v != null);

// "Today", "Yesterday" or "Fri 23 Oct" — like the time stamp on Apple Health cards.
function relDay(d) {
  const diff = Math.round((asDate(todayIso()) - asDate(d)) / 86_400_000);
  return diff === 0 ? "Today" : diff === 1 ? "Yesterday" : fmtDay(d);
}

// Seconds → "7 hr 20 min" (or "0h32" style for the compact lists).
const hrMin = (s) => (s == null ? null : { h: Math.floor(s / 3600), m: Math.round((s % 3600) / 60) });
const hm = (s) => (s == null ? "—" : `${hrMin(s).h}h${String(hrMin(s).m).padStart(2, "0")}`);

// Stroke icons for card labels (24×24).
const ICONS = {
  heart: '<path d="M12 20s-7-4.4-8.8-8.6C1.9 8.2 3.8 5 7 5c2 0 3.4 1.1 5 3 1.6-1.9 3-3 5-3 3.2 0 5.1 3.2 3.8 6.4C19 15.6 12 20 12 20z"/>',
  wave: '<path d="M2 12h4l2.5-6 4 12 3-8 2 2h4.5"/>',
  gauge: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l4-5"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  scale: '<rect x="3" y="4" width="18" height="16" rx="4"/><path d="M8 10a4 4 0 0 1 8 0"/><path d="M12 10l1.5-2"/>',
  load: '<path d="M3 20h18"/><path d="M6 16v-4"/><path d="M11 16V8"/><path d="M16 16v-6"/>',
  run: '<circle cx="15" cy="4.5" r="1.8"/><path d="M8 21l3-6 3 2v4"/><path d="M6 11l3-3h4l2 3h3"/><path d="M11 15l2-5"/>',
  dumbbell: '<path d="M6 7v10M3 9.5v5M18 7v10M21 9.5v5M6 12h12"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
};
const label = (text, icon, color) =>
  `<span class="label" style="--c: var(${color})"><svg viewBox="0 0 24 24">${ICONS[icon]}</svg>${esc(text)}</span>`;

// ---------- Gauges ----------

// Ring gauge: an arc showing value/max, used for readiness and sleep score.
// `text` goes in the centre (defaults to "/max").
function ring(value, max, color, text = `/${max}`, size = 76) {
  const r = size / 2 - 6, c = 2 * Math.PI * r, frac = Math.max(0, Math.min(1, (value ?? 0) / max));
  return `<svg class="viz" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--track)" stroke-width="8"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(${color})" stroke-width="8" stroke-linecap="round"
      stroke-dasharray="${frac * c} ${c}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
    <text x="50%" y="50%" dy="0.35em" text-anchor="middle" class="ring-text">${value == null ? "" : esc(text)}</text>
  </svg>`;
}

// Sparkline: a soft filled trend line ending in a dot on the latest value.
function sparkline(values, color, w = 128, h = 52) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null);
  if (pts.length < 2) return "";
  const lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
  const x = (i) => 4 + (i / (values.length - 1)) * (w - 8);
  const y = (v) => h - 6 - ((v - lo) / (hi - lo || 1)) * (h - 14);
  const line = pts.map(([i, v]) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const [li, lv] = pts.at(-1);
  const id = `g${Math.random().toString(36).slice(2, 8)}`;
  return `<svg class="viz" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="var(${color})" stop-opacity="0.22"/><stop offset="1" stop-color="var(${color})" stop-opacity="0"/>
    </linearGradient></defs>
    <polygon points="${x(pts[0][0])},${h} ${line} ${x(li)},${h}" fill="url(#${id})"/>
    <polyline points="${line}" fill="none" stroke="var(${color})" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(li)}" cy="${y(lv)}" r="3.6" fill="var(--card)" stroke="var(${color})" stroke-width="2.2"/>
  </svg>`;
}

// Colour for Garmin's status words (HIGH / BALANCED / LOW …).
function statusColor(word) {
  const w = String(word ?? "").toUpperCase();
  if (["HIGH", "PRIME", "BALANCED", "GOOD", "EXCELLENT"].includes(w)) return "--ok";
  if (["MODERATE", "FAIR", "UNBALANCED"].includes(w)) return "--warn";
  return w ? "--bad" : "--muted";
}
const chip = (word) => (word ? `<span class="chip" style="--c: var(${statusColor(word)})">${esc(word.replace(/_/g, " "))}</span>` : "");

// ---------- Health cards ----------

function metricCard({ title, icon, color, date, value, unit, viz, caption }) {
  return `<div class="card">
    <div class="card-head">${label(title, icon, color)}<span class="when">${date ? relDay(date) : ""}</span></div>
    <div class="metric">
      <div><span class="big">${value ?? "—"}</span>${value != null && unit ? `<span class="unit">${unit}</span>` : ""}</div>
      ${viz ?? ""}
    </div>
    <div class="caption">${caption ?? ""}</div>
  </div>`;
}

function renderHealth({ health, weights }) {
  const latest = (key) => [...health].reverse().find((h) => h[key] != null);
  const waiting = "Waiting for the first Garmin sync";

  const ready = latest("readiness_score");
  const rhr = latest("resting_hr");
  const hrv = latest("hrv_last_night");
  const sleep = latest("sleep_s");
  const load = latest("acute_load");
  const w = weights.at(-1);
  const weekAgo = w && [...weights].reverse().find((x) => new Date(x.measured_at) <= new Date(new Date(w.measured_at) - 6 * 86_400_000));
  const rhrs = nums(health, "resting_hr");

  const sleepTime = sleep && hrMin(sleep.sleep_s);
  const stages = sleep && [["Deep", sleep.deep_s, "--sleep"], ["Light", sleep.light_s, "--hrv"], ["REM", sleep.rem_s, "--ready"], ["Awake", sleep.awake_s, "--weight"]];
  const stageTotal = stages ? stages.reduce((s, [, v]) => s + (v ?? 0), 0) : 0;

  $("healthCards").innerHTML = [
    metricCard({
      title: "Readiness", icon: "gauge", color: "--ready", date: ready?.date,
      value: ready?.readiness_score, viz: ready && ring(ready.readiness_score, 100, "--ready"),
      caption: ready ? `${chip(ready.readiness_level)} Garmin training readiness` : waiting,
    }),
    metricCard({
      title: "Resting Heart Rate", icon: "heart", color: "--heart", date: rhr?.date,
      value: rhr?.resting_hr, unit: "bpm", viz: sparkline(health.map((h) => h.resting_hr), "--heart"),
      caption: rhrs.length ? `14-day average ${Math.round(avg(rhrs))} bpm` : waiting,
    }),
    metricCard({
      title: "Heart Rate Variability", icon: "wave", color: "--hrv", date: hrv?.date,
      value: hrv?.hrv_last_night, unit: "ms", viz: sparkline(health.map((h) => h.hrv_last_night), "--hrv"),
      caption: hrv ? `${chip(hrv.hrv_status)} overnight average` : waiting,
    }),
    `<div class="card">
      <div class="card-head">${label("Sleep", "moon", "--sleep")}<span class="when">${sleep ? relDay(sleep.date) : ""}</span></div>
      <div class="metric">
        <div>${sleepTime ? `<span class="big">${sleepTime.h}</span><span class="unit">hr</span> <span class="big">${sleepTime.m}</span><span class="unit">min</span>` : '<span class="big">—</span>'}</div>
        ${sleep?.sleep_score != null ? ring(sleep.sleep_score, 100, "--sleep", `${sleep.sleep_score}`) : ""}
      </div>
      ${stageTotal ? `<div class="stages">${stages.map(([, v, c]) => `<span style="flex:${v ?? 0}; background: var(${c})"></span>`).join("")}</div>
        <div class="legend">${stages.map(([n, v, c]) => `<span><i style="background: var(${c})"></i>${n} ${hm(v)}</span>`).join("")}</div>`
        : `<div class="caption">${waiting}</div>`}
    </div>`,
    metricCard({
      title: "Weight", icon: "scale", color: "--weight", date: w?.measured_at,
      value: w?.weight_kg?.toFixed(1), unit: "kg", viz: sparkline(weights.filter((x) => new Date(x.measured_at) > Date.now() - 90 * 86_400_000).map((x) => x.weight_kg), "--weight"),
      caption: weekAgo ? `${w.weight_kg - weekAgo.weight_kg >= 0 ? "+" : "−"}${Math.abs(w.weight_kg - weekAgo.weight_kg).toFixed(1)} kg vs a week earlier` : w ? "Withings scales" : "Waiting for the first Withings weigh-in",
    }),
    metricCard({
      title: "Training Load", icon: "load", color: "--load", date: load?.date,
      value: load?.acute_load, viz: sparkline(health.map((h) => h.acute_load), "--load"),
      caption: load ? "Acute load, 7-day weighted" : waiting,
    }),
  ].join("");
}

// ---------- Coach's note (small markdown renderer: headings, bold, lists) ----------

function markdown(md) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  let html = "", list = null;
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    let m;
    if (!line) { closeList(); continue; }
    if ((m = line.match(/^#{1,4}\s+(.*)/))) { closeList(); html += `<h3>${inline(m[1])}</h3>`; continue; }
    if ((m = line.match(/^(?:[-*])\s+(.*)/)) || (m = line.match(/^\d+\.\s+(.*)/))) {
      const type = /^\d/.test(line) ? "ol" : "ul";
      if (list !== type) { closeList(); html += `<${type}>`; list = type; }
      html += `<li>${inline(m[1])}</li>`;
      continue;
    }
    closeList();
    html += `<p>${inline(line)}</p>`;
  }
  closeList();
  return html;
}

// Collapsed by default: the head shows a one-line preview, and opening it shows the full note.
function renderNote(note) {
  if (!note) return;
  const body = note.body.replace(/^#\s.*\n/, ""); // drop Claude's own title line; the card head already says it
  const preview = body.split("\n").map((l) => l.replace(/[#*]/g, "").trim()).find((l) => l.length > 20) ?? "";
  $("note").innerHTML = `<details>
    <summary>
      <div class="card-head">${label("Coach's note", "spark", "--coach")}<span class="when">${relDay(note.date)} <span class="chev">›</span></span></div>
      <div class="note-preview">${esc(preview)}</div>
    </summary>
    <div class="note-body">${markdown(body)}</div>
  </details>`;
}

// ---------- Training ----------

function renderWeek({ weeks, days }) {
  const today = todayIso();
  const week = weeks.find((w) => today >= w.start_date && today <= w.end_date) ?? weeks.at(-1);
  if (!week) return ($("weekCard").innerHTML = `${label("This week", "run", "--run")}<div class="empty">No plan imported yet.</div>`);

  const rows = days.filter((d) => d.week_start === week.start_date);
  const done = rows.reduce((s, d) => s + (d.actual_km ?? 0), 0);
  const planned = week.planned_total_km ?? rows.reduce((s, d) => s + (d.planned_km ?? 0), 0);
  $("weekCard").innerHTML = `
    <div class="card-head">${label("This week", "run", "--run")}<span class="when">${esc(week.label)} · ${fmtShort(week.start_date)} – ${fmtShort(week.end_date)}</span></div>
    <div class="week-total"><span class="big">${done.toFixed(1)}</span><span class="unit">of ${planned} km</span></div>
    <div class="progress"><span style="width:${Math.min(100, (done / (planned || 1)) * 100)}%"></span></div>
    <div class="week">${rows.map((d) => `
      <div class="day${d.date === today ? " today" : ""}" title="${esc([d.gym, d.run_type].filter(Boolean).join(" · "))}">
        ${asDate(d.date).toLocaleDateString(undefined, { weekday: "short" })}
        <b>${asDate(d.date).getDate()}</b>
        <div class="km">${d.actual_km ?? d.planned_km ?? ""}</div>
        <div class="status ${d.planned_km || d.actual_km ? d.status : ""}"></div>
      </div>`).join("")}</div>`;

  const next = days.find((d) => d.date >= today && d.planned_km && d.status === "upcoming");
  $("nextCard").innerHTML = `
    <div class="card-head">${label("Next run", "run", "--run")}<span class="when">${next ? relDay(next.date) : ""}</span></div>
    ${next ? `
      <div class="big">${next.planned_km}<span class="unit">km</span></div>
      <div class="caption" style="font-size:15px;color:var(--text);font-weight:600">${esc(next.run_type ?? "Run")}</div>
      <div class="caption">${esc([next.hr_guide, next.shoe].filter(Boolean).join(" · "))}</div>
      <div class="caption">${esc(next.gym ? `Gym that morning: ${next.gym}` : "")}</div>`
    : '<div class="empty">No run planned yet.</div>'}`;
}

// Coach → Running plan: the current block's rules, then week by week with the
// coach's comment under each run. Opens on the week containing today.
function renderPlan({ weeks, days, runningBlock }) {
  if (!weeks.length) return ($("planList").innerHTML = '<div class="empty">No plan imported yet.</div>');
  const today = todayIso();
  const b = runningBlock;
  if (b) {
    const day = Math.floor((asDate(today) - asDate(b.start)) / 86_400_000) + 1;
    const total = Math.floor((asDate(b.end) - asDate(b.start)) / 86_400_000) + 1;
    const next = days.find((d) => d.date >= today && d.planned_km && d.status === "upcoming");
    $("runPlanWhen").innerHTML = `${esc(b.name)} · day ${Math.min(day, total)} of ${total}${next ? ` · next ${asDate(next.date).toLocaleDateString(undefined, { weekday: "short" })} ${next.planned_km} km` : ""} <span class="chev">›</span>`;
    $("blockInfo").innerHTML = `
      <div class="block-info">
        <div class="row-title">${esc(b.name)} · ${fmtShort(b.start)} – ${fmtShort(b.end)}</div>
        ${b.summary ? `<p>${esc(b.summary)}</p>` : ""}
        ${b.success ? `<p><strong>Success measure:</strong> ${esc(b.success)}</p>` : ""}
        ${b.rules?.length ? `<details><summary>Block rules (${b.rules.length})</summary><ul>${b.rules.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></details>` : ""}
      </div>`;
  }

  let i = weeks.findIndex((w) => today >= w.start_date && today <= w.end_date);
  if (i === -1) i = weeks.length - 1;
  const statusColor = { done: "--ok", flag: "--warn", missed: "--bad" };

  const show = () => {
    const w = weeks[i];
    $("weekTitle").textContent = `${w.block && w.block !== "Comeback" ? `${w.block} · ` : ""}${w.label} · ${fmtShort(w.start_date)} – ${fmtShort(w.end_date)}`;
    $("weekSummary").textContent = [w.planned_total_km != null ? `${w.planned_total_km} km planned` : "", w.summary ?? ""].filter(Boolean).join(" · ");
    $("prevWeek").disabled = i === 0;
    $("nextWeek").disabled = i === weeks.length - 1;
    $("planList").innerHTML = days.filter((d) => d.week_start === w.start_date).map((d) => {
      const isRun = d.planned_km || d.actual_km;
      // On run days the coach's comment is the point, so it's shown in full;
      // on other days it sits behind a toggle.
      const comment = !d.notes ? "" : isRun
        ? `<div class="comment">${esc(d.notes)}</div>`
        : `<details><summary>Coach's note</summary><p>${esc(d.notes)}</p></details>`;
      return `
      <div class="row${d.date === today ? " row-today" : ""}">
        <div class="row-date"><b>${asDate(d.date).toLocaleDateString(undefined, { weekday: "short" })}</b>${fmtShort(d.date)}</div>
        <div class="row-main">
          <div class="row-title">${esc(isRun ? `${d.run_type ?? "Run"}${d.planned_km ? ` ${d.planned_km} km` : ""}` : "No run")}
            ${isRun ? `<span class="chip" style="--c: var(${statusColor[d.status] ?? "--muted"})">${d.status}</span>` : ""}</div>
          <div class="row-detail">${esc([d.gym && `Gym: ${d.gym}`, isRun && d.hr_guide, isRun && d.shoe].filter(Boolean).join(" · "))}</div>
          ${comment}
        </div>
        <div class="row-side">${d.actual_km != null ? `${d.actual_km} km` : ""}
          <div class="muted">${d.actual_hr ? `<span class="${d.actual_hr > HR_GUIDE ? "hot" : ""}">${d.actual_hr} bpm</span>` : d.actual_km != null ? "actual" : ""}</div></div>
      </div>`;
    }).join("");
  };
  $("prevWeek").onclick = () => { i--; show(); };
  $("nextWeek").onclick = () => { i++; show(); };
  show();
}

// Who changed the plan, what and why (from plan_changes), newest first.
function renderPlanChanges(changes) {
  const fmtVal = (o) => Object.entries(o ?? {}).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v ?? "—"}`).join(", ");
  $("changesSummary").textContent = `Plan change log${changes.length ? ` (${changes.length} recent)` : ""}`;
  $("planChanges").innerHTML = changes.length ? changes.map((c) => `
    <div class="row">
      <div class="row-date"><b>${relDay(c.at.slice(0, 10))}</b>${new Date(c.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</div>
      <div class="row-main">
        <div class="row-title">${esc(c.action.replace(/_/g, " "))} · ${esc(c.target)}</div>
        <div class="row-detail">${esc(c.reason)} — ${esc(c.author)}</div>
        ${c.action === "create_block" ? "" : `<div class="row-detail">${c.before ? `${esc(fmtVal(c.before))} → ` : ""}${esc(fmtVal(c.after))}</div>`}
      </div>
    </div>`).join("") : '<div class="empty">No edits since the plan moved online.</div>';
}

function renderLiftingPlan(plan) {
  if (!plan?.text) return;
  $("liftingWhen").innerHTML = `updated ${relDay(plan.updated_at.slice(0, 10))} by ${esc(plan.updated_by)} <span class="chev">›</span>`;
  $("liftingPlan").innerHTML = markdown(plan.text);
}

function renderActivities(recent) {
  $("activityList").innerHTML = recent.length ? recent.map((a) => `
    <div class="row">
      <div class="row-date"><b>${relDay(a.date)}</b>${a.start_local.slice(11, 16)}</div>
      <div class="row-main">
        <div class="row-title">${esc(a.name ?? a.type)}</div>
        <div class="row-detail">${esc(a.type.replace(/_/g, " "))}${a.training_effect_label ? ` · ${esc(a.training_effect_label.replace(/_/g, " ").toLowerCase())}` : ""}</div>
      </div>
      <div class="row-side">${a.distance_km ? `${a.distance_km} km` : hm(a.duration_s)}
        <div class="muted">${a.avg_hr ? `<span class="${a.type === "running" && a.avg_hr > HR_GUIDE ? "hot" : ""}">${a.avg_hr} bpm</span>` : ""}</div></div>
    </div>`).join("") : '<div class="empty">No activities yet. They come from Garmin.</div>';
}

function renderGym(gym) {
  $("gymList").innerHTML = `<div class="card-head">${label("Sessions", "dumbbell", "--gym")}<span class="when">JEFIT · last 14 days</span></div>` + (gym.length ? gym.map((g) => {
    const sets = g.exercises.reduce((s, e) => s + (e.sets?.length ?? 0), 0);
    return `<div class="row">
      <div class="row-date"><b>${relDay(g.date)}</b></div>
      <div class="row-main">
        <div class="row-title">${esc(g.name ?? "Workout")}</div>
        <div class="tags">${g.exercises.map((e) => `<span class="tag">${esc(e.name)} ×${e.sets?.length ?? 0}</span>`).join("")}</div>
      </div>
      <div class="row-side">${sets}<div class="muted">sets</div></div>
    </div>`;
  }).join("") : '<div class="empty">No JEFIT sessions in the last 14 days.</div>');
}

// ---------- Block review: is the current block working? ----------

// One tile: a value, an optional "of N" target, and the change vs the previous
// 4 weeks. `better` says which direction is good ("up", "down" or null).
function tile(title, value, { of, unit = "", delta, better, dp = 0 } = {}) {
  let change = "";
  if (delta != null && Math.abs(delta) >= 10 ** -dp / 2) {
    const good = better === "up" ? delta > 0 : better === "down" ? delta < 0 : null;
    const color = good == null ? "--muted" : good ? "--ok" : "--bad";
    change = `<span class="delta" style="--c: var(${color})">${delta > 0 ? "▲" : "▼"} ${Math.abs(delta).toFixed(dp)}</span>`;
  }
  return `<div class="tile">
    <div class="tile-title">${title}</div>
    <div class="tile-value">${value ?? "—"}${value != null && unit ? `<span class="unit">${unit}</span>` : ""}${of != null ? `<span class="unit"> of ${of}</span>` : ""}</div>
    ${change || '<span class="delta">&nbsp;</span>'}
  </div>`;
}

function renderBlock(block) {
  const card = $("blockCard");
  const draw = (view) => {
    const b = { current: block.current, last4: block.last4, since: block.sinceStart }[view];
    const prev = view === "last4" ? block.prev4 : null; // deltas only make sense against an equal-length window
    const d = (key) => (prev && b[key] != null && prev[key] != null ? b[key] - prev[key] : null);
    const pct = (a, n) => (n ? `${Math.round((a / n) * 100)}%` : "—");
    card.innerHTML = `
      <div class="card-head">${label("Block review", "spark", "--run")}
        <div class="segmented" id="blockRange">
          ${block.current ? `<button data-v="current" class="${view === "current" ? "on" : ""}">This block</button>` : ""}
          <button data-v="last4" class="${view === "last4" ? "on" : ""}">Last 4 weeks</button>
          <button data-v="since" class="${view === "since" ? "on" : ""}">Since ${fmtShort(block.sinceStart.start)}</button>
        </div>
      </div>
      <div class="tiles">
        ${tile("Planned runs done", b.runs_done, { of: b.runs_planned, delta: d("runs_done"), better: "up" })}
        ${tile("Distance", b.km, { of: `${b.km_planned} km`, delta: d("km"), better: "up", dp: 1 })}
        ${tile("Runs under HR guide", b.runs_under_guide, { of: b.runs, delta: d("runs_under_guide"), better: "up" })}
        ${tile("Avg run HR", b.avg_run_hr, { unit: "bpm", delta: d("avg_run_hr"), better: "down" })}
        ${tile("Gym sessions / week", b.gym_per_week, { delta: d("gym_per_week"), better: null, dp: 1 })}
        ${tile("Readiness", b.readiness, { delta: d("readiness"), better: "up" })}
        ${tile("HRV", b.hrv, { unit: "ms", delta: d("hrv"), better: "up", dp: 1 })}
        ${tile("Resting HR", b.resting_hr, { unit: "bpm", delta: d("resting_hr"), better: "down", dp: 1 })}
        ${tile("Sleep score", b.sleep_score, { delta: d("sleep_score"), better: "up" })}
        ${tile("Weight change", b.weight_change_kg != null ? `${b.weight_change_kg > 0 ? "+" : ""}${b.weight_change_kg}` : null, { unit: "kg" })}
      </div>
      ${view === "current" ? `
        <div class="caption"><strong>${esc(b.name)}</strong> · day ${Math.min(b.day, b.total_days)} of ${b.total_days} · ${b.runs_done} of ${b.runs_in_block} runs done so far</div>
        <div class="progress"><span style="width:${Math.min(100, (b.runs_done / (b.runs_in_block || 1)) * 100)}%"></span></div>
        ${b.success ? `<div class="caption">Success measure: ${esc(b.success)}</div>` : ""}`
      : `<div class="caption">Run adherence ${pct(b.runs_done, b.runs_planned)} · ${b.runs} runs logged in total${prev ? " · ▲▼ vs the 4 weeks before" : ""}</div>`}`;
    card.querySelectorAll("#blockRange button").forEach((btn) => (btn.onclick = () => draw(btn.dataset.v)));
  };
  if (block?.sinceStart) draw(block.current ? "current" : "last4");
  else card.innerHTML = `${label("Block review", "spark", "--run")}<div class="empty">No plan imported yet.</div>`;
}

// ---------- Gym plan (current JEFIT routine) ----------

// Sets → "1×12 @ 20 kg · 5×6 @ 30 kg": consecutive identical sets are grouped.
function setSummary(sets) {
  const groups = [];
  for (const st of sets) {
    const last = groups.at(-1);
    if (last && last.reps === st.reps && last.weight_kg === st.weight_kg) last.n++;
    else groups.push({ ...st, n: 1 });
  }
  return groups.map((g) => `${g.n}×${g.reps ?? "?"}${g.weight_kg ? ` @ ${g.weight_kg} kg` : ""}`).join(" · ");
}

function renderGymPlan(plan, lastDone) {
  const card = $("gymPlan");
  if (!plan) {
    $("gymPlanHead").innerHTML = label("Gym plan", "dumbbell", "--gym");
    return (card.innerHTML = '<div class="empty">Appears after the next JEFIT sync.</div>');
  }
  // Open on the day trained longest ago — the one most likely to be next.
  const oldest = [...plan.days].sort((a, b) => (lastDone[a.name] ?? "").localeCompare(lastDone[b.name] ?? ""))[0];
  $("gymPlanHead").innerHTML = `${label(`Gym plan · ${plan.name}`, "dumbbell", "--gym")}
    <span class="when">${plan.days.length} days · next up ${esc(oldest.name)} <span class="chev">›</span></span>`;
  const draw = (dayName) => {
    const day = plan.days.find((d) => d.name === dayName);
    card.innerHTML = `
      <div class="caption" style="margin: 0 0 8px">${esc(dayName)}: ${lastDone[dayName] ? `last done ${relDay(lastDone[dayName])}` : "not done recently"}</div>
      <div class="pills">${plan.days.map((d) => `<button class="pill${d.name === dayName ? " on" : ""}" data-day="${esc(d.name)}">${esc(d.name)}</button>`).join("")}</div>
      ${day.exercises.map((e, i) => `
        <div class="row">
          <div class="row-date"><b>${i + 1}</b></div>
          <div class="row-main"><div class="row-title">${esc(e.name)}</div><div class="row-detail">${esc(setSummary(e.sets))}</div></div>
          <div class="row-side">${e.sets.length}<div class="muted">sets</div></div>
        </div>`).join("")}`;
    card.querySelectorAll(".pill").forEach((p) => (p.onclick = () => draw(p.dataset.day)));
  };
  draw(oldest.name);
}

// ---------- Charts (Chart.js, styled to match the cards) ----------

function chartDefaults() {
  Chart.defaults.font.family = css("--sans");
  Chart.defaults.color = css("--muted");
  Chart.defaults.borderColor = css("--line");
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.legend.labels.boxWidth = 6;
  Chart.defaults.plugins.legend.labels.boxHeight = 6;
  Chart.defaults.elements.line.tension = 0.35;
  Chart.defaults.elements.line.borderWidth = 2.2;
  Chart.defaults.elements.point.radius = 0;
  Chart.defaults.elements.point.hoverRadius = 5;
  Chart.defaults.maintainAspectRatio = false;
  Chart.defaults.interaction = { mode: "index", intersect: false };
}

const axes = (extra = {}) => ({
  x: { grid: { display: false }, ticks: { maxTicksLimit: 7 } },
  y: { grid: { color: css("--line") }, border: { display: false }, ...extra.y },
  ...(extra.y1 && { y1: { position: "right", grid: { display: false }, border: { display: false }, ...extra.y1 } }),
});

// Swap a chart's canvas for a short message when there's nothing to plot yet.
function noData(id, datasets, message) {
  if (datasets.some((d) => d.data.some((v) => v != null && v !== 0))) return false;
  $(id).parentElement.innerHTML = `<div class="chart-empty">${message}</div>`;
  return true;
}

function line(id, labels, datasets, scales, empty = "No data yet") {
  if (noData(id, datasets.filter((d) => !d.reference), empty)) return;
  new Chart($(id), {
    type: "line",
    data: { labels, datasets: datasets.map((d) => ({ backgroundColor: "transparent", spanGaps: true, ...d })) },
    options: { scales: scales ?? axes() },
  });
}

function renderCharts({ weeks, days, health, weights, runs }) {
  chartDefaults();
  const hLabels = health.map((h) => fmtShort(h.date));
  line("hrvChart", hLabels, [
    { label: "Resting HR", data: health.map((h) => h.resting_hr), borderColor: css("--heart") },
    { label: "HRV (ms)", data: health.map((h) => h.hrv_last_night), borderColor: css("--hrv"), yAxisID: "y1" },
  ], axes({ y1: {} }), "Waiting for the first Garmin sync");
  line("readinessChart", hLabels, [
    { label: "Readiness", data: health.map((h) => h.readiness_score), borderColor: css("--ready") },
    { label: "Acute load", data: health.map((h) => h.acute_load), borderColor: css("--load"), borderDash: [4, 4], yAxisID: "y1" },
  ], axes({ y: { min: 0, max: 100 }, y1: {} }), "Waiting for the first Garmin sync");
  renderWeightChart(weights);
  line("hrTrendChart", runs.map((r) => fmtShort(r.date)), [
    { label: "Avg HR", data: runs.map((r) => r.avg_hr), borderColor: css("--heart"), pointRadius: 3 },
    { label: "Easy guide", data: runs.map(() => HR_GUIDE), borderColor: css("--ok"), borderDash: [3, 4], borderWidth: 1.5, reference: true },
  ], undefined, "Runs appear here once Garmin is connected");

  const recentWeeks = weeks.slice(-10);
  const actual = recentWeeks.map((w) => days.filter((d) => d.week_start === w.start_date).reduce((s, d) => s + (d.actual_km ?? 0), 0));
  new Chart($("volumeChart"), {
    type: "bar",
    data: {
      labels: recentWeeks.map((w) => w.label.replace("Week ", "W")),
      datasets: [
        { label: "Planned", data: recentWeeks.map((w) => w.planned_total_km), backgroundColor: css("--track"), borderRadius: 6 },
        { label: "Actual", data: actual, backgroundColor: css("--run"), borderRadius: 6 },
      ],
    },
    options: { scales: axes({ y: { beginAtZero: true } }) },
  });

  const nights = health.slice(-7);
  const hours = (s) => (s == null ? null : +(s / 3600).toFixed(2));
  const sleepSets = [["Deep", "deep_s", "--sleep"], ["Light", "light_s", "--hrv"], ["REM", "rem_s", "--ready"], ["Awake", "awake_s", "--weight"]]
    .map(([l, k, c]) => ({ label: l, data: nights.map((h) => hours(h[k])), backgroundColor: css(c), borderRadius: 4 }));
  if (noData("sleepChart", sleepSets, "Waiting for the first Garmin sync")) return;
  new Chart($("sleepChart"), {
    type: "bar",
    data: { labels: nights.map((h) => fmtShort(h.date)), datasets: sleepSets },
    options: { scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, border: { display: false }, title: { display: true, text: "hours" } } } },
  });
}

// Weight chart with a 3M / 1Y / All switch. Longer ranges label by month and year.
let weightChart;
function renderWeightChart(weights) {
  if (noData("weightChart", [{ data: weights.map((w) => w.weight_kg) }], "Waiting for the first Withings weigh-in")) return;
  const draw = (days) => {
    const since = days ? Date.now() - days * 86_400_000 : 0;
    const shown = weights.filter((w) => new Date(w.measured_at) >= since);
    const fmt = days && days <= 120 ? fmtShort : (d) => asDate(d).toLocaleDateString(undefined, { month: "short", year: "2-digit" });
    weightChart?.destroy();
    weightChart = new Chart($("weightChart"), {
      type: "line",
      data: { labels: shown.map((w) => fmt(w.measured_at)), datasets: [{ label: "Weight (kg)", data: shown.map((w) => w.weight_kg), borderColor: css("--weight"), backgroundColor: "transparent", borderWidth: 1.8 }] },
      options: { scales: axes(), plugins: { legend: { display: false } } },
    });
  };
  const buttons = [...document.querySelectorAll("#weightRange button")];
  for (const b of buttons) {
    b.onclick = () => { buttons.forEach((x) => x.classList.toggle("on", x === b)); draw(Number(b.dataset.days)); };
  }
  draw(365);
}

// ---------- Status, alerts, navigation ----------

function renderSync(syncs) {
  const latest = syncs.reduce((a, s) => (!a || s.started_at > a.started_at ? s : a), null);
  $("lastSync").textContent = latest
    ? `Last sync ${new Date(latest.started_at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`
    : "Not synced yet";
  $("syncList").innerHTML = syncs.map((s) => `<span title="${esc(s.message)}"><span class="dot" style="--c: var(${s.ok ? "--ok" : "--bad"})"></span> ${esc(s.source)}</span>`).join("");
}

// Banner for anything Daniel has to fix himself (expired Garmin session, Withings not connected…).
function renderAlerts(alerts) {
  $("alerts").innerHTML = alerts.map((a, i) => `
    <div class="alert">
      <div class="alert-title">${esc(a.title)}</div>
      <div>${esc(a.detail)}</div>
      ${a.command ? `<div class="alert-cmd"><code id="cmd${i}">${esc(a.command)}</code>
        <button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('cmd${i}').textContent); this.textContent='Copied'">Copy</button></div>` : ""}
      ${a.link ? `<a class="btn" href="${esc(a.link.href)}">${esc(a.link.text)}</a>` : ""}
    </div>`).join("");
}

// Highlight the sidebar link for the section currently on screen.
function trackSections() {
  const links = [...document.querySelectorAll("#nav a")];
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) links.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === `#${e.target.id}`));
    }
  }, { rootMargin: "-30% 0px -60% 0px" });
  document.querySelectorAll("main section").forEach((s) => observer.observe(s));
}

async function main() {
  trackSections();
  const res = await fetch("/api/dashboard");
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  const data = await res.json();
  renderSync(data.syncs);
  renderAlerts(data.alerts);
  renderHealth(data);
  renderNote(data.note);
  renderWeek(data);
  renderPlan(data);
  renderPlanChanges(data.planChanges ?? []);
  renderLiftingPlan(data.liftingPlan);
  renderActivities(data.recent);
  renderBlock(data.block);
  renderGymPlan(data.gymPlan, data.gymLastDone ?? {});
  renderGym(data.gym);
  renderCharts(data);
}

main().catch((err) => ($("lastSync").textContent = `Couldn't load: ${err.message}`));
