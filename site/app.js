/* Inference data explorer. Reads the CSV tables next to this page, types them
   with datapackage.json, and renders with Observable Plot. All labels come from
   the CSVs, so they are inserted with textContent, never innerHTML. */

"use strict";

const TABLES = ["sources", "hardware", "models", "measurements"];
const EVIDENCE = ["measured_by_source", "vendor_claim", "unverified_claim", "derived"];
const EVIDENCE_LABEL = {
  measured_by_source: "measured",
  vendor_claim: "vendor claim",
  unverified_claim: "unverified",
  derived: "derived",
};
const EVIDENCE_SYMBOL = ["circle", "square", "triangle", "diamond"];
const SLOTS = 7;
const OTHER = "Other devices";

const TABS = ["measurements", "hardware"];
const state = {tab: "measurements", model: "", hw: "", metric: "decode_tok_s", evidence: new Set(EVIDENCE.slice(0, 3))};
const sort = {key: null, dir: 1};
let db;

main().catch((err) => {
  const box = document.getElementById("chart-scaling");
  box.textContent = "Could not load the data: " + err.message;
  box.className = "chart empty";
});

async function main() {
  const pkg = await d3.json("datapackage.json");
  const tables = {};
  await Promise.all(TABLES.map(async (name) => {
    const resource = pkg.resources.find((r) => r.name === name);
    const fields = Object.fromEntries(resource.schema.fields.map((f) => [f.name, f.type]));
    tables[name] = await d3.csv(resource.path, (row) => typed(row, fields));
  }));
  db = index(tables);
  readUrl();
  initTabs();
  initFilters();
  renderTiles();
  render();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
  let width = innerWidth;
  addEventListener("resize", () => {
    if (Math.abs(innerWidth - width) > 40) { width = innerWidth; render(); }
  });
}

function typed(row, fields) {
  const out = {};
  for (const [key, raw] of Object.entries(row)) {
    if (raw === "") out[key] = null;
    else if (fields[key] === "integer" || fields[key] === "number") out[key] = +raw;
    else out[key] = raw;
  }
  return out;
}

function index(t) {
  const hardware = new Map(t.hardware.map((h) => [h.hardware_id, h]));
  const models = new Map(t.models.map((m) => [m.model_id, m]));
  const sources = new Map(t.sources.map((s) => [s.source_id, s]));
  const rows = t.measurements.map((m) => {
    const hw = hardware.get(m.hardware_id);
    const model = models.get(m.model_id);
    const src = sources.get(m.source_id);
    const hwName = hw ? shortName(hw.name) : "Unidentified device";
    return {
      ...m,
      hwName,
      device: m.hw_count > 1 ? `${hwName} ×${m.hw_count}` : hwName,
      modelName: model ? model.name : "Unidentified model",
      sourceTitle: src ? src.title : m.source_id,
      sourceUrl: src ? src.url : null,
      // The schema has no series column yet; sweeps share an id stem and
      // differ by a -c<concurrency> part (ecohash-mtp-c16, ecohash-mtp-c32).
      series: [m.hardware_id, m.hw_count, m.model_id, m.quantization, m.engine, m.source_id,
        m.measurement_id.replace(/-c\d+(?=-|$)/, "")].join("|"),
    };
  });

  // Colour follows the device, fixed for the whole page: the most-measured
  // devices take the first slots, everything else shares the muted "other".
  const counts = d3.rollup(rows.filter((r) => r.evidence !== "derived" && r.hardware_id), (v) => v.length, (r) => r.hardware_id);
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || d3.ascending(a[0], b[0])).map((d) => d[0]);
  const slot = new Map(ranked.slice(0, SLOTS).map((id, i) => [id, i]));
  for (const r of rows) r.colorKey = slot.has(r.hardware_id) ? r.hwName : OTHER;
  const colorDomain = [...ranked.slice(0, SLOTS).map((id) => shortName(hardware.get(id).name)), OTHER];

  return {sourceList: t.sources, hardware, models, sources, rows, slot, colorDomain};
}

function shortName(name) {
  const s = name.replace(/^(NVIDIA|AMD|Apple)\s+/, "").replace(/^GeForce\s+/, "");
  const paren = s.indexOf("(");
  if (paren < 0) return s;
  const base = s.slice(0, paren).trim();
  let inner = s.slice(paren + 1).split(/[,)]/)[0].trim();
  if (inner.split(/\s+/).length > 2) inner = inner.split(/\s+/)[0];
  return base.includes(inner) ? base : `${base} (${inner})`;
}

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function palette() {
  return [...Array.from({length: SLOTS}, (_, i) => css(`--series-${i + 1}`)), css("--series-other")];
}

/* ---------- filters and URL state ---------- */

function readUrl() {
  const q = new URLSearchParams(location.search);
  if (TABS.includes(q.get("tab"))) state.tab = q.get("tab");
  Hardware.read(q);
  if (q.has("model")) state.model = q.get("model");
  if (q.has("hw")) state.hw = q.get("hw");
  if (q.get("metric") === "decode_tok_s_per_user") state.metric = "decode_tok_s_per_user";
  if (q.has("evidence")) state.evidence = new Set(q.get("evidence").split(",").filter((e) => EVIDENCE.includes(e)));
}

function writeUrl() {
  const q = new URLSearchParams();
  if (state.tab !== "measurements") q.set("tab", state.tab);
  if (state.model) q.set("model", state.model);
  if (state.hw) q.set("hw", state.hw);
  if (state.metric !== "decode_tok_s") q.set("metric", state.metric);
  q.set("evidence", [...state.evidence].join(","));
  Hardware.write(q);
  history.replaceState(null, "", `${location.pathname}?${q}`);
}

function initTabs() {
  const buttons = TABS.map((t) => document.getElementById(`tab-${t}`));
  buttons.forEach((b, i) => {
    b.addEventListener("click", () => { state.tab = TABS[i]; render(); });
    b.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      const next = buttons[(i + step + buttons.length) % buttons.length];
      next.focus();
      next.click();
    });
  });
}

function syncTabs() {
  for (const t of TABS) {
    const active = t === state.tab;
    const b = document.getElementById(`tab-${t}`);
    b.setAttribute("aria-selected", String(active));
    b.tabIndex = active ? 0 : -1;
    document.getElementById(t).hidden = !active;
  }
}

function initFilters() {
  const model = document.getElementById("f-model");
  const hw = document.getElementById("f-hw");
  const metric = document.getElementById("f-metric");
  metric.value = state.metric;
  for (const box of document.querySelectorAll("input[name=evidence]")) {
    box.checked = state.evidence.has(box.value);
    box.addEventListener("change", () => {
      box.checked ? state.evidence.add(box.value) : state.evidence.delete(box.value);
      render();
    });
  }
  model.addEventListener("change", () => { state.model = model.value; render(); });
  hw.addEventListener("change", () => { state.hw = hw.value; render(); });
  metric.addEventListener("change", () => { state.metric = metric.value; render(); });
  document.getElementById("download").addEventListener("click", download);
}

function syncOptions() {
  const pool = db.rows.filter((r) => state.evidence.has(r.evidence));
  const byModel = d3.rollups(pool.filter((r) => r.model_id), (v) => v.length, (r) => r.model_id)
    .sort((a, b) => b[1] - a[1] || d3.ascending(a[0], b[0]));
  if (!byModel.some(([id]) => id === state.model)) state.model = byModel.length ? byModel[0][0] : "";
  fill(document.getElementById("f-model"), byModel.map(([id, n]) => [id, `${db.models.get(id).name} (${n})`]), state.model);

  const inModel = pool.filter((r) => r.model_id === state.model && r.hardware_id);
  const byHw = d3.rollups(inModel, (v) => v.length, (r) => r.hardware_id)
    .sort((a, b) => d3.ascending(db.hardware.get(a[0]).name, db.hardware.get(b[0]).name));
  if (state.hw && !byHw.some(([id]) => id === state.hw)) state.hw = "";
  fill(document.getElementById("f-hw"), [["", "All devices"], ...byHw.map(([id, n]) => [id, `${shortName(db.hardware.get(id).name)} (${n})`])], state.hw);
}

function fill(select, options, value) {
  select.replaceChildren(...options.map(([v, label]) => {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    return o;
  }));
  select.value = value;
}

function selection() {
  return db.rows.filter((r) =>
    state.evidence.has(r.evidence) &&
    r.model_id === state.model &&
    (!state.hw || r.hardware_id === state.hw));
}

/* ---------- render ---------- */

// Only the visible tab renders: charts size themselves to their container,
// which has no width while hidden.
function render() {
  syncTabs();
  syncOptions();
  writeUrl();
  if (state.tab === "hardware") return Hardware.render(db);
  const rows = selection();
  renderScaling(rows);
  renderSingle(rows);
  renderTable(rows);
}

function renderTiles() {
  const measured = db.rows.filter((r) => r.evidence !== "derived");
  const latest = d3.max(db.sourceList, (s) => s.date_accessed);
  const tiles = [
    ["Published results", measured.length.toLocaleString("en")],
    ["Devices", new Set(measured.map((r) => r.hardware_id).filter(Boolean)).size],
    ["Models", new Set(measured.map((r) => r.model_id).filter(Boolean)).size],
    ["Sources", db.sourceList.length],
    ["Last source checked", latest],
  ];
  document.getElementById("tiles").replaceChildren(...tiles.map(([label, value]) => {
    const tile = el("div", "tile");
    tile.append(el("div", "label", label), el("div", "value", String(value)));
    return tile;
  }));
}

function plotStyle() {
  return {background: "transparent", color: css("--text-secondary"), fontSize: "12px", fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"};
}

function colorScale(rows) {
  const present = new Set(rows.map((r) => r.colorKey));
  const range = palette();
  const domain = db.colorDomain.filter((d) => present.has(d));
  return {domain, range: domain.map((d) => range[db.colorDomain.indexOf(d)]), legend: true};
}

function symbolScale(rows) {
  const present = EVIDENCE.filter((e) => rows.some((r) => r.evidence === e));
  return {
    domain: present.map((e) => EVIDENCE_LABEL[e]),
    range: present.map((e) => EVIDENCE_SYMBOL[EVIDENCE.indexOf(e)]),
    legend: true,
  };
}

function tipChannels(metric) {
  return {
    Device: "device",
    Quantization: (r) => r.quantization ?? "not stated",
    Engine: (r) => [r.engine, r.engine_version].filter(Boolean).join(" ") || "not stated",
    Concurrency: (r) => r.concurrency ?? "not stated",
    [metric === "decode_tok_s" ? "Aggregate tok/s" : "Per-user tok/s"]: metric,
    Evidence: (r) => EVIDENCE_LABEL[r.evidence],
    Source: "sourceTitle",
  };
}

const TIP_FORMAT = {x: false, y: false, fill: false, symbol: false, stroke: false};

function renderScaling(rows) {
  const box = document.getElementById("chart-scaling");
  const metric = state.metric;
  const data = rows.filter((r) => r[metric] != null && r.concurrency != null && r[metric] > 0);
  const missing = rows.filter((r) => r[metric] != null && r.concurrency == null).length;
  const label = metric === "decode_tok_s" ? "Aggregate decode tok/s" : "Per-user decode tok/s";
  document.getElementById("scaling-sub").textContent =
    `${label} for ${db.models.get(state.model)?.name ?? "this model"}. Lines join the points of one published sweep; other results stay as dots. Hover a point for its setup and source.`;
  document.getElementById("scaling-foot").textContent = [
    missing ? `${missing} result${missing > 1 ? "s" : ""} without a stated concurrency ${missing > 1 ? "are" : "is"} in the table only.` : "",
    metric === "decode_tok_s_per_user" ? "Per-user rates are shown only where the source printed one; they are never aggregate divided by concurrency." : "",
  ].filter(Boolean).join(" ");
  if (!data.length) return empty(box, "No result with both a concurrency and this metric for the current filters.");

  const sweeps = d3.groups(data, (r) => r.series)
    .filter(([, v]) => v.length > 1 && new Set(v.map((r) => r.concurrency)).size === v.length);
  const lines = sweeps.flatMap(([, v]) => v.sort((a, b) => a.concurrency - b.concurrency));
  const xs = data.map((r) => r.concurrency);
  const ticks = d3.range(0, Math.ceil(Math.log2(d3.max(xs))) + 1).map((p) => 2 ** p)
    .filter((t) => t >= d3.min(xs) / 2 && t <= d3.max(xs) * 2);
  const [lo, hi] = d3.extent(data, (r) => r[metric]);
  const yTicks = d3.range(Math.floor(Math.log10(lo)), Math.ceil(Math.log10(hi)) + 1)
    .flatMap((p) => [1, 2, 5].map((m) => m * 10 ** p)).filter((t) => t >= lo / 2 && t <= hi * 2);
  const surface = css("--surface-1");

  box.replaceChildren(Plot.plot({
    width: box.clientWidth || 900,
    height: 420,
    marginLeft: 56,
    marginRight: 16,
    style: plotStyle(),
    // Axis marks set `text`: on a log scale Plot blanks tickFormat labels
    // that do not start with 1 or 2, such as concurrency 8 and 64.
    x: {type: "log", label: "Concurrency (requests in flight)", insetLeft: 12, insetRight: 12},
    y: {type: "log", label: label, insetTop: 8, insetBottom: 8},
    color: colorScale(data),
    symbol: symbolScale(data),
    marks: [
      Plot.gridX(ticks, {stroke: css("--grid"), strokeOpacity: 1}),
      Plot.gridY(yTicks, {stroke: css("--grid"), strokeOpacity: 1}),
      Plot.axisX(ticks, {text: String, label: "Concurrency (requests in flight)"}),
      Plot.axisY(yTicks, {text: d3.format("~s"), label}),
      Plot.line(lines, {x: "concurrency", y: metric, z: "series", stroke: "colorKey", strokeWidth: 2, strokeOpacity: 0.85, curve: "linear"}),
      Plot.dot(data, {
        x: "concurrency", y: metric, fill: "colorKey", symbol: (r) => EVIDENCE_LABEL[r.evidence],
        r: 5, stroke: surface, strokeWidth: 2,
        channels: tipChannels(metric),
        tip: {format: TIP_FORMAT},
      }),
    ],
  }));
}

function renderSingle(rows) {
  const box = document.getElementById("chart-single");
  const metric = state.metric;
  const data = rows.filter((r) => r.concurrency === 1 && r[metric] != null);
  if (!data.length) return empty(box, "No concurrency-1 result with this metric for the current filters.");
  const order = d3.groupSort(data, (v) => -d3.max(v, (r) => r[metric]), (r) => r.device);
  const marginLeft = Math.min(240, 16 + 6.5 * d3.max(order, (d) => d.length));
  const surface = css("--surface-1");

  box.replaceChildren(Plot.plot({
    width: box.clientWidth || 900,
    height: 60 + 34 * order.length,
    marginLeft,
    marginRight: 64,
    style: plotStyle(),
    x: {label: metric === "decode_tok_s" ? "Decode tok/s at concurrency 1" : "Per-user decode tok/s at concurrency 1", grid: true, zero: true, nice: true},
    y: {label: null, domain: order, padding: 0.3},
    color: colorScale(data),
    symbol: symbolScale(data),
    marks: [
      Plot.ruleX([0], {stroke: css("--axis")}),
      Plot.dot(data, {
        x: metric, y: "device", fill: "colorKey", symbol: (r) => EVIDENCE_LABEL[r.evidence],
        r: 5.5, stroke: surface, strokeWidth: 2,
        channels: tipChannels(metric),
        tip: {format: TIP_FORMAT},
      }),
      Plot.text(data, Plot.groupY({x: "max", text: "max"}, {
        x: metric, y: "device", text: metric, dx: 12, textAnchor: "start",
        fill: css("--text-secondary"), fontVariant: "tabular-nums",
      })),
    ],
  }));
}

/* ---------- table ---------- */

const COLUMNS = [
  {key: "device", label: "Device"},
  {key: "quantization", label: "Quant"},
  {key: "engine", label: "Engine"},
  {key: "input_tokens", label: "In tok", num: true},
  {key: "output_tokens", label: "Out tok", num: true},
  {key: "concurrency", label: "Conc.", num: true},
  {key: "prefill_tok_s", label: "Prefill tok/s", num: true},
  {key: "decode_tok_s", label: "Decode tok/s", num: true},
  {key: "decode_tok_s_per_user", label: "Per-user tok/s", num: true},
  {key: "ttft_ms", label: "TTFT ms", num: true},
  {key: "power_w", label: "Power W", num: true},
  {key: "task_time_s", label: "Task s", num: true},
  {key: "evidence", label: "Evidence"},
  {key: "sourceTitle", label: "Source"},
  {key: "notes", label: "Notes"},
];

function renderTable(rows) {
  const table = document.getElementById("table");
  document.getElementById("table-sub").textContent =
    `${rows.length} row${rows.length === 1 ? "" : "s"} for ${db.models.get(state.model)?.name ?? "this model"}. Blank means the source did not state it; the notes say why. Click a header to sort.`;
  let data = rows.slice();
  if (sort.key) {
    data.sort((a, b) => {
      const x = a[sort.key], y = b[sort.key];
      if (x == null) return 1;
      if (y == null) return -1;
      return sort.dir * (typeof x === "number" ? x - y : String(x).localeCompare(String(y)));
    });
  }
  const head = el("tr");
  for (const c of COLUMNS) {
    const th = el("th", c.num ? "num" : "", c.label);
    th.scope = "col";
    if (sort.key === c.key) th.setAttribute("aria-sort", sort.dir > 0 ? "ascending" : "descending");
    th.addEventListener("click", () => {
      sort.dir = sort.key === c.key ? -sort.dir : (c.num ? -1 : 1);
      sort.key = c.key;
      renderTable(rows);
    });
    head.append(th);
  }
  const body = data.map((r) => {
    const tr = el("tr");
    for (const c of COLUMNS) {
      const v = r[c.key];
      const td = el("td", c.num ? "num" : "");
      if (c.key === "evidence") td.append(el("span", "badge", EVIDENCE_LABEL[v]));
      else if (c.key === "sourceTitle" && r.sourceUrl) {
        const a = el("a", "", truncate(v, 40));
        a.href = r.sourceUrl;
        a.rel = "noopener";
        a.title = v;
        td.append(a);
      } else if (c.key === "notes") {
        td.className = "notes";
        const details = el("details");
        details.append(el("summary", "", truncate(v ?? "", 80)), el("div", "", v ?? ""));
        td.append(details);
      } else td.textContent = v == null ? "" : c.num ? fmt(v) : v;
      tr.append(td);
    }
    return tr;
  });
  table.replaceChildren(el("thead"), el("tbody"));
  table.tHead.append(head);
  table.tBodies[0].append(...body);
}

function download() {
  const fields = ["measurement_id", "hardware_id", "hw_count", "model_id", "quantization", "engine", "engine_version",
    "context_tokens", "input_tokens", "output_tokens", "concurrency", "prefill_tok_s", "decode_tok_s",
    "decode_tok_s_per_user", "ttft_ms", "power_w", "task_time_s", "source_id", "evidence", "notes", "sourceUrl"];
  const csv = d3.csvFormat(selection().map((r) => Object.fromEntries(fields.map((f) => [f === "sourceUrl" ? "source_url" : f, r[f] ?? ""]))));
  const a = el("a");
  a.href = URL.createObjectURL(new Blob([csv + "\n"], {type: "text/csv"}));
  a.download = `inference-data-${state.model || "all"}${state.hw ? "-" + state.hw : ""}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- helpers ---------- */

function el(tag, className = "", text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function empty(box, message) {
  box.replaceChildren(el("p", "empty", message));
}

function fmt(v) {
  return typeof v === "number" ? v.toLocaleString("en", {maximumFractionDigits: 2}) : v;
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
