/* Inference data explorer. Reads the CSV tables next to this page, types them
   with datapackage.json, and draws with d3. All labels come from the CSVs, so
   they are inserted with textContent or d3 .text(), never innerHTML. */

"use strict";

const TABLES = ["sources", "hardware", "models", "measurements"];
const ATLAS = ["gpus", "systems", "measures", "models"];
// Agentic tables are declared in datapackage.json but are not sourced measurements.
const AGENTIC = {cloud: "agentic_selftimed_steps", box: "claude_code_box_requests"};
const ATLAS_NUMERIC = new Set(["price_usd", "memory_gb", "bandwidth_gbs", "tflops_bf16", "power_w", "gpus", "users",
  "decode_tps", "prefill_tps", "prefill_tokens", "aa_index", "weights_gb", "total_params_b", "active_params_b"]);
const SUBS = {memory: "hardware", bandwidth: "hardware", compute: "hardware", "hardware-data": "hardware", "inference-data": "inference",
  "agentic-cloud": "agentic", "agentic-box": "agentic", "agentic-dvp": "agentic", "agentic-data": "agentic"};
const EVIDENCE_LABEL = {
  measured_by_source: "measured",
  vendor_claim: "vendor claim",
  unverified_claim: "unverified",
  derived: "derived",
};

// Colour is the brand, shape the family, so each family reads without colour.
const BRANDS = [{k: "NVIDIA", token: "--brand-nvidia"}, {k: "AMD", token: "--brand-amd"}];
const GPU_FAMILIES = [
  {k: "geforce", label: "GeForce RTX 50", symbol: d3.symbolCircle},
  {k: "radeon", label: "Radeon RX 7000 and 9000", symbol: d3.symbolDiamond},
  {k: "rtxpro", label: "RTX PRO Blackwell", symbol: d3.symbolTriangle},
  {k: "radeonpro", label: "Radeon PRO and AI PRO", symbol: d3.symbolWye},
  {k: "nvhbm", label: "NVIDIA HBM (datacenter, DGX Station)", symbol: d3.symbolSquare},
  {k: "instinct", label: "AMD Instinct HBM", symbol: d3.symbolCross},
  {k: "unified", label: "Unified memory (Spark, Ryzen AI Max)", symbol: d3.symbolStar},
];
const SYS_FAMILIES = [
  {k: "unified", label: "Unified-memory mini PC", symbol: d3.symbolStar},
  {k: "single", label: "Single-GPU workstation", symbol: d3.symbolCircle},
  {k: "pcie", label: "Multi-GPU PCIe workstation or server", symbol: d3.symbolTriangle},
  {k: "station", label: "DGX Station GB300", symbol: d3.symbolDiamond},
  {k: "server", label: "8-GPU HBM server", symbol: d3.symbolSquare},
  {k: "rack", label: "72-GPU rack (NVL72, Helios)", symbol: d3.symbolCross},
];
const MODEL_FAMILIES = [
  {k: "gptoss", label: "gpt-oss-120b", symbol: d3.symbolCircle},
  {k: "qwen", label: "Qwen3.8-27B", symbol: d3.symbolTriangle},
  {k: "ds", label: "DeepSeek V4 and V4.1 Flash", symbol: d3.symbolDiamond},
  {k: "glm", label: "GLM-5.3 and GLM-5.3-Flash", symbol: d3.symbolSquare},
  {k: "kimi", label: "Kimi K2.6", symbol: d3.symbolCross},
];
const familyOf = (list, k) => list.find((f) => f.k === (k === "station" && list === GPU_FAMILIES ? "nvhbm" : k)) || list[0];

const CAPS = {
  memory: {col: "memory_gb", label: "Memory (GB)", unit: "GB", title: "Memory",
    note: "GB of memory, summed over the machine at computer scale. Diagonals give the price per GB or the GB per kW."},
  bandwidth: {col: "bandwidth_gbs", label: "Memory bandwidth (GB/s)", unit: "GB/s", title: "Bandwidth",
    note: "GB/s of memory bandwidth. Diagonals give the price per GB/s or the GB/s per watt."},
  compute: {col: "tflops_bf16", label: "Dense 16-bit TFLOPS", unit: "TFLOPS", title: "Compute",
    note: "Dense BF16 or FP16 tensor TFLOPS as vendors publish them. Diagonals give the price per TFLOPS or the TFLOPS per kW."},
};

// Diagonals of a constant ratio y / x, keyed by "<x>-<capability>".
const RATIOS = {
  "price-memory": {at: (x, b) => x / b, base: [1, 10, 100, 1000], label: (b) => `$${num(b)} per GB`},
  "price-bandwidth": {at: (x, b) => x / b, base: [0.1, 1, 10, 100], label: (b) => `$${num(b)} per GB/s`},
  "price-compute": {at: (x, b) => x / b, base: [1, 10, 100, 1000], label: (b) => `$${num(b)} per TFLOPS`},
  "power-memory": {at: (x, b) => (x * b) / 1000, base: [10, 100, 1000], label: (b) => `${num(b)} GB per kW`},
  "power-bandwidth": {at: (x, b) => x * b, base: [1, 10], label: (b) => `${num(b)} GB/s per W`},
  "power-compute": {at: (x, b) => (x * b) / 1000, base: [100, 1000], label: (b) => `${num(b)} TFLOPS per kW`},
  decode: {at: (x, b) => x / b, base: [1, 3, 10, 30, 100], label: (b) => `${num(b)} GB read per token`},
  prefill: {at: (x, b) => x * b, base: [1, 10, 100], label: (b) => `${num(b)} tok/s per TFLOPS`},
};

const state = {sub: "memory", lastHardware: "memory", lastAgentic: "agentic-cloud", x: "log", y: "log", q: "", derived: false,
  ag: {measure: null, platform: "all", split: "cell", dup: false, boxMeasure: null, excluded: false, axis: "shared", dvpExcluded: false, dvpY: "log"}};
const sorts = {agCloud: {key: null, dir: 1}, agBox: {key: null, dir: 1}, hw: {key: "bandwidth_gb_s", dir: -1}, m: {key: null, dir: 1}, gpus: {key: null, dir: 1}, systems: {key: null, dir: 1}, measures: {key: null, dir: 1}, models: {key: "aa_index", dir: -1}};
let db;

main().catch((err) => {
  const box = document.getElementById("c-gpu-price");
  box.replaceChildren(el("p", "empty", "Could not load the data: " + err.message));
});

async function main() {
  const pkg = await d3.json("datapackage.json");
  const tables = {};
  await Promise.all(TABLES.map(async (name) => {
    const resource = pkg.resources.find((r) => r.name === name);
    const types = Object.fromEntries(resource.schema.fields.map((f) => [f.name, f.type]));
    tables[name] = await d3.csv(resource.path, (row) => typed(row, types));
  }));
  const atlas = {};
  await Promise.all(ATLAS.map(async (name) => {
    atlas[name] = await d3.csv(`data/atlas/${name}.csv`, (row) => typed(row, (k) => ATLAS_NUMERIC.has(k)));
  }));
  db = index(tables, atlas);
  db.agentic = {};
  await Promise.all(Object.entries(AGENTIC).map(async ([key, name]) => {
    const resource = pkg.resources.find((r) => r.name === name);
    const types = Object.fromEntries(resource.schema.fields.map((f) => [f.name, f.type]));
    const rows = await d3.csv(resource.path, (row) => typed(row, types));
    db.agentic[key] = {rows, fields: resource.schema.fields, types};
  }));
  readLegacyQuery();
  readHash();
  wire();
  render();
  addEventListener("hashchange", () => { readHash(); render(); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
  let width = innerWidth;
  addEventListener("resize", () => {
    if (Math.abs(innerWidth - width) > 40) { width = innerWidth; render(); }
  });
}

// `types` maps a column to its datapackage type, or is a predicate saying
// whether a column is numeric.
function typed(row, types) {
  const numeric = typeof types === "function" ? types : (k) => types[k] === "integer" || types[k] === "number";
  const out = {};
  for (const [key, raw] of Object.entries(row)) {
    if (raw === "") out[key] = null;
    else if (numeric(key)) out[key] = +raw;
    else out[key] = raw;
  }
  return out;
}

function index(t, atlas) {
  const sources = new Map(t.sources.map((s) => [s.source_id, s]));
  const models = new Map(t.models.map((m) => [m.model_id, m]));
  const devices = t.hardware.map((h) => {
    const src = sources.get(h.source_id);
    return {...h, short: shortName(h.name), sourceTitle: src ? src.title : h.source_id, sourceUrl: src ? src.url : null};
  });
  const hardware = new Map(devices.map((d) => [d.hardware_id, d]));
  const rows = t.measurements.map((m) => {
    const hw = hardware.get(m.hardware_id);
    const model = models.get(m.model_id);
    const src = sources.get(m.source_id);
    return {
      ...m,
      device: hw ? (m.hw_count > 1 ? `${hw.short} ×${m.hw_count}` : hw.short) : "Unidentified device",
      modelName: model ? model.name : "Unidentified model",
      sourceTitle: src ? src.title : m.source_id,
      sourceUrl: src ? src.url : null,
      sourceDate: src ? src.date_published : null,
    };
  });
  return {devices, rows, atlas};
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

/* ---------- navigation ---------- */

// Links from the earlier explorer used query parameters (?tab=hardware&hv=
// compute&hxs=lin). Map them onto the current views once, then drop them.
function readLegacyQuery() {
  const q = new URLSearchParams(location.search);
  if (!q.toString()) return;
  if (!location.hash) {
    const view = {compute: "compute", price: "memory", power: "bandwidth"}[q.get("hv")] || "memory";
    const sub = q.get("tab") === "hardware" ? view : q.has("model") ? "inference-data" : null;
    if (sub) history.replaceState(null, "", `${location.pathname}#${sub}`);
  }
  if (q.get("hxs") === "lin") state.x = "lin";
  if (q.get("hys") === "lin") state.y = "lin";
  if (location.search) history.replaceState(null, "", location.pathname + location.hash);
}

function readHash() {
  const h = location.hash.slice(1);
  if (SUBS[h]) state.sub = h;
  if (SUBS[state.sub] === "hardware") state.lastHardware = state.sub;
  if (SUBS[state.sub] === "agentic") state.lastAgentic = state.sub;
}

function go(sub) {
  if (location.hash.slice(1) === sub) return render();
  location.hash = sub;
}

function wire() {
  for (const b of document.querySelectorAll(".tabs button")) {
    b.addEventListener("click", () => go({inference: "inference-data", agentic: state.lastAgentic}[b.dataset.tab] || state.lastHardware));
  }
  for (const b of document.querySelectorAll(".subtabs button")) b.addEventListener("click", () => go(b.dataset.sub));
  for (const seg of document.querySelectorAll(".seg[data-axis]")) {
    for (const b of seg.querySelectorAll("button")) {
      b.addEventListener("click", () => { state[seg.dataset.axis] = b.dataset.s; render(); });
    }
  }
  for (const b of document.querySelectorAll("#theme button")) b.addEventListener("click", () => setTheme(b.dataset.theme));
  const q = document.getElementById("q");
  q.addEventListener("input", () => { state.q = q.value; renderMeasurements(); });
  const derived = document.getElementById("with-derived");
  derived.addEventListener("change", () => { state.derived = derived.checked; renderMeasurements(); });
  document.getElementById("download").addEventListener("click", download);
  wireAgentic();
}

function syncNav() {
  const top = SUBS[state.sub];
  for (const b of document.querySelectorAll(".tabs button")) {
    const on = b.dataset.tab === top;
    b.setAttribute("aria-selected", String(on));
    b.tabIndex = on ? 0 : -1;
    document.getElementById(`panel-${b.dataset.tab}`).hidden = !on;
  }
  for (const b of document.querySelectorAll(".subtabs button")) b.setAttribute("aria-selected", String(b.dataset.sub === state.sub));
  for (const seg of document.querySelectorAll(".seg[data-axis]")) {
    for (const b of seg.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.s === state[seg.dataset.axis]));
  }
  const theme = document.documentElement.dataset.theme || "auto";
  for (const b of document.querySelectorAll("#theme button")) b.setAttribute("aria-pressed", String(b.dataset.theme === theme));
  const isCap = Boolean(CAPS[state.sub]);
  document.getElementById("capability").hidden = !isCap;
  document.getElementById("axes").hidden = !isCap;
  document.getElementById("hardware-data").hidden = state.sub !== "hardware-data";
  for (const v of document.querySelectorAll(".agentic-view")) v.hidden = v.id !== state.sub;
  document.getElementById("ag-axis-ctl").hidden = state.sub === "agentic-data" || state.sub === "agentic-dvp";
  for (const id of ["ag-split", "ag-axis"]) {
    const key = id === "ag-split" ? "split" : "axis";
    for (const b of document.querySelectorAll(`#${id} button`)) b.setAttribute("aria-pressed", String(b.dataset.v === state.ag[key]));
  }
}

// Auto follows the system setting; Light and Dark override it and are
// remembered in this browser only.
function setTheme(theme) {
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    if (theme === "auto") localStorage.removeItem("theme");
    else localStorage.setItem("theme", theme);
  } catch (e) {
    // Storage can be blocked; the choice then lasts for this page view.
  }
  render();
}

// Only the visible view renders: charts size themselves to their container,
// which has no width while hidden.
function render() {
  syncNav();
  if (CAPS[state.sub]) renderCapability(state.sub);
  else if (state.sub === "hardware-data") renderHardwareData();
  else if (state.sub === "agentic-cloud") renderCloud();
  else if (state.sub === "agentic-box") renderBox();
  else if (state.sub === "agentic-dvp") renderDecodeVsPrefill();
  else if (state.sub === "agentic-data") renderAgenticData();
  else renderMeasurements();
}

/* ---------- capability tabs ---------- */

function brandColor(vendor) {
  const b = BRANDS.find((x) => x.k === vendor);
  return css(b ? b.token : "--series-other");
}

function renderCapability(cap) {
  const C = CAPS[cap];
  document.getElementById("cap-note").textContent = C.note;
  const {gpus, systems} = db.atlas;
  const present = new Set([...gpus, ...systems].map((d) => d.vendor));
  document.getElementById("leg-brand").replaceChildren(...BRANDS.filter((b) => present.has(b.k)).map((b) => legendKey(b.k, d3.symbolCircle, css(b.token))));
  document.getElementById("leg-gpu").replaceChildren(...shapeLegend(GPU_FAMILIES, gpus.map((d) => familyOf(GPU_FAMILIES, d.family))));
  document.getElementById("leg-sys").replaceChildren(...shapeLegend(SYS_FAMILIES, systems.map((d) => familyOf(SYS_FAMILIES, d.family))));
  for (const [scale, rows, fams, what] of [["gpu", gpus, GPU_FAMILIES, "a GPU"], ["sys", systems, SYS_FAMILIES, "a computer"]]) {
    for (const [xk, xLabel, col] of [["price", "Price (US dollars)", "price_usd"], ["power", "Power (W)", "power_w"]]) {
      document.getElementById(`t-${scale}-${xk}`).textContent = `${C.title} of ${what} against its ${xk}`;
      const items = rows.map((d) => ({
        x: d[col], y: d[C.col],
        label: d.name + (cap === "compute" && d.tflops_basis === "derived" ? " ≈" : ""),
        symbol: familyOf(fams, d.family).symbol, color: brandColor(d.vendor),
        tip: hardwareTip(d, familyOf(fams, d.family)),
      }));
      scatter(`${scale}-${xk}`, items, {
        xLabel, yLabel: C.label, xMoney: xk === "price", ratio: RATIOS[`${xk}-${cap}`],
      });
    }
  }
  if (cap === "memory") renderModelReach();
  else renderMeasured(cap);
}

function hardwareTip(d, fam) {
  const rows = [["t", d.name], ["s", `${d.vendor} · ${fam.label}`]];
  if (d.price_usd != null) rows.push(["r", "Price", `$${num(d.price_usd)}`]);
  if (d.memory_gb != null) rows.push(["r", "Memory", `${num(d.memory_gb)} GB`]);
  if (d.bandwidth_gbs != null) rows.push(["r", "Bandwidth", `${num(d.bandwidth_gbs)} GB/s`]);
  if (d.tflops_bf16 != null) rows.push(["r", "Dense 16-bit", `${num(d.tflops_bf16)} TFLOPS${d.tflops_basis === "derived" ? " (derived)" : ""}`]);
  if (d.power_w != null) rows.push(["r", "Power", `${num(d.power_w)} W`]);
  if (d.gpus != null) rows.push(["r", "GPUs", String(d.gpus)]);
  if (d.price_basis) rows.push(["s", `Price: ${d.price_basis}`]);
  if (d.note) rows.push(["s", d.note]);
  return rows;
}

function renderMeasured(cap) {
  const bw = cap === "bandwidth";
  document.getElementById("yield-group").textContent = bw ? "What bandwidth buys: generation speed" : "What compute buys: prefill speed";
  document.getElementById("t-yield").textContent = bw ? "Measured generation against bandwidth" : "Measured prefill against compute";
  document.getElementById("n-yield").textContent = bw
    ? "Generation for one user, or four for datacenter GPUs, the smallest published level. To produce each token the machine rereads the model's active weights: the diagonals give the amount read per token that each point implies, and one model should follow one diagonal. Hollow points: speculative decoding, which validates several tokens per read and so beats that limit."
    : "Prefill for one user, or four for datacenter GPUs, on prompts of 0.5k to 32k tokens. Prefill processes every prompt token at once: it is bound by compute. Diagonals give tokens ingested per second per 16-bit TFLOPS; a model quantized to FP4 or FP8 beats what the 16-bit figure suggests, and a long prompt costs more per token because of attention.";
  const legend = [
    ...MODEL_FAMILIES.filter((f) => db.atlas.measures.some((m) => m.model_family === f.k)).map((f) => legendKey(f.label, f.symbol, css("--text-secondary"))),
    legendKey("Speculative decoding", d3.symbolCircle, css("--text-secondary"), true),
  ];
  document.getElementById("leg-yield").replaceChildren(...legend);
  const items = db.atlas.measures.map((m) => ({
    x: bw ? m.bandwidth_gbs : m.tflops_bf16,
    y: bw ? m.decode_tps : m.prefill_tps,
    label: m.machine,
    symbol: familyOf(MODEL_FAMILIES, m.model_family).symbol,
    color: brandColor(m.machine_vendor),
    hollow: m.speculative === "yes",
    tip: [
      ["t", m.machine],
      ["s", [m.model, m.quant, m.engine].filter(Boolean).join(" · ")],
      ["r", "Concurrent users", String(m.users)],
      ...(m.decode_tps != null ? [["r", "Generation per user", `${num(m.decode_tps)} tok/s${m.decode_context && m.decode_context !== "empty" ? ` (context ${m.decode_context})` : ""}`]] : []),
      ...(m.prefill_tps != null ? [["r", "Prefill per user", `${num(m.prefill_tps)} tok/s${m.prefill_tokens ? ` (${num(m.prefill_tokens)}-token prompt)` : ""}`]] : []),
      ...(m.speculative === "yes" ? [["s", "Speculative decoding"]] : []),
      ...(m.note ? [["s", m.note]] : []),
      ["s", `Source: ${m.source}`],
    ],
  }));
  scatter("yield", items, {
    xLabel: bw ? "Memory bandwidth of the machine (GB/s)" : "Dense 16-bit TFLOPS of the machine",
    yLabel: bw ? "Generation per user (tok/s)" : "Prefill per user (tok/s)",
    ratio: RATIOS[bw ? "decode" : "prefill"],
  });
}

// The best open model whose official weights plus 10% fit in each machine's
// GPU memory, against the Artificial Analysis index.
function renderModelReach() {
  document.getElementById("yield-group").textContent = "What memory buys: the intelligence you can load";
  document.getElementById("t-yield").textContent = "Best open model that fits, against memory";
  document.getElementById("n-yield").textContent = "Hollow circles: the ten best open models on Artificial Analysis, placed at the memory their official weights need plus a 10% margin. The step line gives the best index reachable for a given memory, and each machine sits on it. Stronger quantization or offloading to RAM lowers these thresholds: DeepSeek V4.1 Flash already runs on 4× RTX PRO 6000. Memory also sets the room left for agent context, which this chart ignores.";
  const {models, systems} = db.atlas;
  const open = models.filter((m) => m.weights_gb > 0).map((m) => ({...m, need: m.weights_gb * 1.1})).sort((a, b) => a.need - b.need);
  const closed = models.filter((m) => !(m.weights_gb > 0) && m.aa_index > 0);
  const best = (mem) => open.filter((m) => m.need <= mem).sort((a, b) => b.aa_index - a.aa_index)[0];
  const muted = css("--text-secondary");
  document.getElementById("leg-yield").replaceChildren(legendKey("Open model, at the memory its weights need", d3.symbolCircle, muted, true));
  const items = [
    ...open.map((m) => ({
      x: m.need, y: m.aa_index, label: m.name, symbol: d3.symbolCircle, color: muted, hollow: true, quiet: true,
      tip: [["t", m.name], ["s", `Open model · ${m.licence}`], ["r", "AA index", String(m.aa_index)],
        ["r", "Weights", `${num(m.weights_gb)} GB (${m.weights_basis}, ${m.format})`], ["r", "Memory with 10% margin", `${num(m.need)} GB`],
        ["r", "Parameters", `${num(m.total_params_b)}B, ${num(m.active_params_b)}B active`]],
    })),
    ...systems.map((s) => {
      const fit = best(s.memory_gb);
      return {
        x: s.memory_gb, y: fit ? fit.aa_index : null, label: s.name,
        symbol: familyOf(SYS_FAMILIES, s.family).symbol, color: brandColor(s.vendor),
        tip: [["t", s.name], ["s", `${s.vendor} · ${familyOf(SYS_FAMILIES, s.family).label}`], ["r", "GPU memory", `${num(s.memory_gb)} GB`],
          ["r", "Best model that fits", fit ? fit.name : "none"], ...(fit ? [["r", "AA index", String(fit.aa_index)]] : [])],
      };
    }),
  ];
  scatter("yield", items, {
    xLabel: "GPU memory of the machine, or memory the model needs (GB)",
    yLabel: "Artificial Analysis intelligence index",
    missingText: (names) => `No listed model fits in: ${names.join(", ")}.`,
    extraY: closed.map((m) => m.aa_index),
    yPad: [1.25, 1.12],
    overlay: (g, x, y, iw) => {
      const [x0, x1] = x.domain();
      const cuts = [x0, ...open.map((m) => m.need).filter((v) => v > x0 && v < x1), x1];
      const steps = [];
      for (let i = 0; i < cuts.length - 1; i++) {
        const m = best(cuts[i] * 1.000001);
        if (m) steps.push([x(cuts[i]), y(m.aa_index)], [x(cuts[i + 1]), y(m.aa_index)]);
      }
      if (steps.length) g.append("path").attr("d", d3.line()(steps)).attr("fill", "none").attr("stroke", css("--reference")).attr("stroke-width", 1.5);
      for (const m of closed) {
        const yy = y(m.aa_index);
        g.append("line").attr("x1", 0).attr("x2", iw).attr("y1", yy).attr("y2", yy).attr("stroke", css("--reference")).attr("stroke-dasharray", "5 4");
        g.append("text").attr("x", iw - 4).attr("y", yy - 6).attr("text-anchor", "end").attr("fill", css("--text-secondary"))
          .style("font-size", "11px").text(`${m.name}: ${m.aa_index} (API, weights not public)`);
      }
    },
  });
}

function shapeLegend(families, used) {
  const present = new Set(used);
  return families.filter((f) => present.has(f)).map((f) => legendKey(f.label, f.symbol, css("--text-secondary")));
}

function legendKey(label, symbol, fill, hollow = false) {
  const s = el("span");
  const svg = d3.create("svg").attr("width", 14).attr("height", 14).attr("viewBox", "-7 -7 14 14").attr("aria-hidden", "true");
  svg.append("path").attr("d", d3.symbol(symbol, 64)())
    .attr("fill", hollow ? "none" : fill).attr("stroke", hollow ? fill : "none").attr("stroke-width", 1.6);
  s.append(svg.node(), document.createTextNode(label));
  return s;
}

/* ---------- the scatter ---------- */

function scatter(id, items, opt) {
  const box = document.getElementById(`c-${id}`);
  const missBox = document.getElementById(`x-${id}`);
  const lgx = state.x === "log", lgy = state.y === "log";
  const pts = items.filter((p) => p.x > 0 && p.y > 0);
  const miss = items.filter((p) => !(p.x > 0 && p.y > 0)).map((p) => p.label);
  missBox.textContent = miss.length && opt.missingText ? opt.missingText(miss) : "";
  box.replaceChildren();
  if (!pts.length) return box.append(el("p", "empty", "No point has both values yet."));

  const W = Math.max(300, box.clientWidth || 800);
  const H = Math.round(Math.min(520, Math.max(340, W * 0.6)));
  const m = {t: 22, r: 16, b: 44, l: 58};
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const [lo, hi] = opt.yPad || [1.6, 1.6];
  const xs = pts.map((p) => p.x), ys = [...pts.map((p) => p.y), ...(opt.extraY || [])];
  const x = (lgx ? d3.scaleLog().domain([d3.min(xs) / 1.6, d3.max(xs) * 2.5]) : d3.scaleLinear().domain([0, d3.max(xs) * 1.1]).nice()).range([0, iw]);
  const y = (lgy ? d3.scaleLog().domain([d3.min(ys) / lo, d3.max(ys) * hi]) : d3.scaleLinear().domain([0, d3.max(ys) * 1.1]).nice()).range([ih, 0]);
  const muted = css("--text-secondary"), surface = css("--surface-1");

  const svg = d3.select(box).append("svg").attr("width", "100%").attr("viewBox", `0 0 ${W} ${H}`)
    .attr("role", "img").attr("aria-label", `${opt.yLabel} against ${opt.xLabel}`)
    .style("font", "12px system-ui, -apple-system, 'Segoe UI', sans-serif");
  const g = svg.append("g").attr("transform", `translate(${m.l},${m.t})`);
  const clipId = `clip-${id}`;
  svg.append("defs").append("clipPath").attr("id", clipId).append("rect").attr("width", iw).attr("height", ih);

  const xt = lgx ? logTicks(...x.domain()) : x.ticks(W < 560 ? 4 : 7);
  const yt = lgy ? logTicks(...y.domain()) : y.ticks(6);
  g.append("g").selectAll("line").data(xt).join("line").attr("x1", x).attr("x2", x).attr("y1", 0).attr("y2", ih).attr("stroke", css("--grid"));
  g.append("g").selectAll("line").data(yt).join("line").attr("y1", y).attr("y2", y).attr("x1", 0).attr("x2", iw).attr("stroke", css("--grid"));
  g.append("line").attr("x1", 0).attr("x2", iw).attr("y1", ih).attr("y2", ih).attr("stroke", css("--axis"));
  g.append("line").attr("x1", 0).attr("x2", 0).attr("y1", 0).attr("y2", ih).attr("stroke", css("--axis"));
  const fx = (v) => (opt.xMoney ? `$${short(v)}` : short(v));
  g.append("g").selectAll("text").data(W < 560 ? xt.filter((_, i) => i % 2 === 0) : xt).join("text")
    .attr("x", x).attr("y", ih + 16).attr("text-anchor", "middle").attr("fill", muted).text(fx);
  g.append("g").selectAll("text").data(yt).join("text")
    .attr("x", -8).attr("y", (d) => y(d) + 4).attr("text-anchor", "end").attr("fill", muted).text(short);
  g.append("text").attr("x", iw).attr("y", ih + 36).attr("text-anchor", "end").attr("fill", muted).text(`${opt.xLabel} →`);
  g.append("text").attr("x", -m.l + 4).attr("y", -10).attr("fill", muted).text(`↑ ${opt.yLabel}`);

  // Diagonals of a constant ratio, labelled at their last visible point.
  const R = opt.ratio;
  const dg = g.append("g").attr("clip-path", `url(#${clipId})`);
  if (R) {
    const [x0, x1] = x.domain();
    for (const b of R.base) {
      const sp = d3.range(121).map((k) => {
        const xv = lgx ? x0 * (x1 / x0) ** (k / 120) : x0 + ((x1 - x0) * k) / 120;
        return [x(xv), y(R.at(xv, b))];
      }).filter(([, py]) => isFinite(py));
      const inside = sp.filter(([px, py]) => py >= 0 && py <= ih && px >= 0 && px <= iw);
      if (inside.length < 2) continue;
      dg.append("path").attr("d", d3.line()(sp)).attr("fill", "none").attr("stroke", css("--reference")).attr("stroke-dasharray", "3 4");
      const pB = inside[inside.length - 1], pA = inside[Math.max(0, inside.length - 4)];
      if (pB[0] < 80) continue;
      const angle = (Math.atan2(pB[1] - pA[1], pB[0] - pA[0]) * 180) / Math.PI;
      dg.append("text").attr("transform", `translate(${pB[0] - 4},${pB[1] + 12}) rotate(${angle})`)
        .attr("text-anchor", "end").attr("fill", muted).style("font-size", "10px").text(R.label(b));
    }
  }
  if (opt.overlay) opt.overlay(dg, x, y, iw, ih);

  // Points, one size; colour is the brand, shape the family.
  const tip = document.getElementById("tip");
  const occupied = [];
  pts.forEach((p) => {
    p.px = x(p.x);
    p.py = y(p.y);
    occupied.push({x0: p.px - 6, x1: p.px + 6, y0: p.py - 6, y1: p.py + 6});
  });
  const nodes = g.append("g").selectAll("g").data(pts).join("g")
    .attr("transform", (p) => `translate(${p.px},${p.py})`)
    .attr("tabindex", 0).attr("role", "img").attr("aria-label", (p) => `${p.label}: ${short(p.x)}, ${short(p.y)}`)
    .style("outline", "none");
  nodes.append("circle").attr("r", 12).attr("fill", "transparent");
  nodes.append("path").attr("d", (p) => d3.symbol(p.symbol, 72)())
    .attr("fill", (p) => (p.hollow ? surface : p.color))
    .attr("stroke", (p) => (p.hollow ? p.color : surface))
    .attr("stroke-width", (p) => (p.hollow ? 1.8 : 1.5));
  const show = (event, p) => {
    fillTip(tip, p.tip);
    const r = event.currentTarget.getBoundingClientRect();
    placeTip(tip, r.x + r.width / 2, r.y);
    d3.select(event.currentTarget).select("path").attr("stroke", css("--text-primary"));
  };
  const hide = (event, p) => {
    tip.hidden = true;
    d3.select(event.currentTarget).select("path").attr("stroke", p.hollow ? p.color : surface);
  };
  nodes.on("pointerenter", show).on("pointerleave", hide).on("focus", show).on("blur", hide);

  // Labels without overlap, isolated points first. A label that does not fit
  // is dropped; the point keeps its tooltip and its table row.
  const labels = g.append("g").attr("pointer-events", "none");
  const over = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
  const crowd = (p) => d3.sum(pts, (q) => Math.hypot(q.px - p.px, q.py - p.py) < 40);
  for (const p of pts.slice().sort((a, b) => crowd(a) - crowd(b))) {
    const t = labels.append("text").attr("fill", p.quiet ? muted : css("--text-primary")).attr("stroke", surface)
      .attr("stroke-width", 3).attr("paint-order", "stroke").style("font-size", "11px").text(p.label);
    const w = t.node().getComputedTextLength(), h = 11;
    const spots = [[8, 4, "start"], [-8, 4, "end"], [8, -6, "start"], [-8, -6, "end"], [8, 14, "start"], [-8, 14, "end"], [0, -10, "middle"], [0, 20, "middle"],
      [-8, -16, "end"], [8, -16, "start"], [-8, 24, "end"], [8, 24, "start"], [0, -20, "middle"], [0, 30, "middle"],
      [-8, -28, "end"], [8, -28, "start"], [-8, 36, "end"], [8, 36, "start"]];
    const fit = spots.find(([dx, dy, anchor]) => {
      const lx = p.px + dx, ly = p.py + dy;
      const bx0 = anchor === "start" ? lx : anchor === "end" ? lx - w : lx - w / 2;
      const b = {x0: bx0, x1: bx0 + w, y0: ly - h + 2, y1: ly + 2};
      if (b.x0 < -m.l + 4 || b.x1 > iw + m.r - 2 || b.y0 < 0 || b.y1 > ih) return false;
      if (occupied.some((o) => over(o, b))) return false;
      occupied.push(b);
      return true;
    });
    if (fit) t.attr("x", p.px + fit[0]).attr("y", p.py + fit[1]).attr("text-anchor", fit[2]);
    else t.remove();
  }
}

function logTicks(lo, hi) {
  const out = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    for (const k of [1, 2, 5]) {
      const v = k * 10 ** e;
      if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v);
    }
  }
  if (out.length > 9) return out.filter((v) => String(v).startsWith("1"));
  // A range under a decade (an index from 20 to 60) gets plain ticks.
  return out.length < 3 ? d3.ticks(lo, hi, 5) : out;
}

function fillTip(tip, rows) {
  tip.replaceChildren(...rows.map(([cls, a, b]) => {
    const d = el("div", cls);
    if (cls === "r") d.append(el("span", "", a), el("span", "", b));
    else d.textContent = a;
    return d;
  }));
  tip.hidden = false;
}

function placeTip(tip, cx, cy) {
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let left = cx + 14, top = cy - h - 8;
  if (left + w > innerWidth - 8) left = cx - w - 14;
  if (top < 8) top = cy + 24;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${top}px`;
}

/* ---------- tables ---------- */

const ATLAS_COLUMNS = {
  gpus: [
    {key: "name", label: "GPU"}, {key: "vendor", label: "Vendor"},
    {key: "family", label: "Family", get: (d) => familyOf(GPU_FAMILIES, d.family).label},
    {key: "price_usd", label: "Price (USD)", num: true}, {key: "price_basis", label: "Price basis"},
    {key: "memory_gb", label: "Memory (GB)", num: true}, {key: "bandwidth_gbs", label: "Bandwidth (GB/s)", num: true},
    {key: "tflops_bf16", label: "Dense 16-bit TFLOPS", num: true}, {key: "tflops_basis", label: "TFLOPS basis"},
    {key: "power_w", label: "Power (W)", num: true}, {key: "note", label: "Note"},
  ],
  systems: [
    {key: "name", label: "Computer"}, {key: "vendor", label: "Vendor"},
    {key: "family", label: "Family", get: (d) => familyOf(SYS_FAMILIES, d.family).label},
    {key: "gpus", label: "GPUs", num: true}, {key: "price_usd", label: "Price (USD)", num: true}, {key: "price_basis", label: "Price basis"},
    {key: "memory_gb", label: "Memory (GB)", num: true}, {key: "bandwidth_gbs", label: "Bandwidth (GB/s)", num: true},
    {key: "tflops_bf16", label: "Dense 16-bit TFLOPS", num: true}, {key: "power_w", label: "Power (W)", num: true}, {key: "note", label: "Note"},
  ],
  measures: [
    {key: "machine", label: "Machine"}, {key: "model", label: "Model"}, {key: "quant", label: "Quant"}, {key: "engine", label: "Engine"},
    {key: "users", label: "Users", num: true}, {key: "decode_tps", label: "Decode tok/s", num: true}, {key: "decode_context", label: "Decode context"},
    {key: "prefill_tps", label: "Prefill tok/s", num: true}, {key: "prefill_tokens", label: "Prompt tokens", num: true},
    {key: "speculative", label: "Speculative"}, {key: "note", label: "Note"}, {key: "source", label: "Source", link: "url"},
  ],
  models: [
    {key: "name", label: "Model"}, {key: "aa_index", label: "AA index", num: true}, {key: "weights_gb", label: "Weights (GB)", num: true},
    {key: "weights_basis", label: "Weights basis"}, {key: "format", label: "Format"}, {key: "licence", label: "Licence"},
    {key: "total_params_b", label: "Total params (B)", num: true}, {key: "active_params_b", label: "Active params (B)", num: true},
  ],
};

const HW_COLUMNS = [
  {key: "name", label: "Device"},
  {key: "vendor", label: "Vendor"},
  {key: "memory_gb", label: "Memory (GB)", num: true},
  {key: "bandwidth_gb_s", label: "Bandwidth (GB/s)", num: true},
  {key: "dense_bf16_fp16_tflops", label: "Dense 16-bit TFLOPS", num: true},
  {key: "fp4_tflops", label: "FP4 TFLOPS", num: true},
  {key: "tdp_w", label: "Power (W)", num: true},
  {key: "launch_price_usd", label: "Launch price (USD)", num: true},
  {key: "market_price_usd", label: "Market price (USD)", num: true},
  {key: "market_price_date", label: "Market price date"},
  {key: "sourceTitle", label: "Source", link: "sourceUrl"},
  {key: "notes", label: "Notes", notes: true},
];

const M_COLUMNS = [
  {key: "measurement_id", label: "Id"},
  {key: "device", label: "Device"},
  {key: "modelName", label: "Model"},
  {key: "quantization", label: "Quant"},
  {key: "engine", label: "Engine"},
  {key: "engine_version", label: "Version"},
  {key: "context_tokens", label: "Context", num: true},
  {key: "input_tokens", label: "In tok", num: true},
  {key: "output_tokens", label: "Out tok", num: true},
  {key: "concurrency", label: "Conc.", num: true},
  {key: "prefill_tok_s", label: "Prefill tok/s", num: true},
  {key: "decode_tok_s", label: "Decode tok/s", num: true},
  {key: "decode_tok_s_per_user", label: "Per-user tok/s", num: true},
  {key: "ttft_ms", label: "TTFT ms", num: true},
  {key: "power_w", label: "Power W", num: true},
  {key: "task_time_s", label: "Task s", num: true},
  {key: "cache_state", label: "Cache"},
  {key: "cache_hit_ratio", label: "Hit ratio", num: true},
  {key: "kv_pool_tokens", label: "KV pool", num: true},
  {key: "evidence", label: "Evidence", badge: true},
  {key: "sourceTitle", label: "Source", link: "sourceUrl"},
  {key: "sourceDate", label: "Published"},
  {key: "notes", label: "Notes", notes: true},
];

function renderHardwareData() {
  for (const name of ATLAS) {
    const redraw = () => drawTable(document.getElementById(`t-atlas-${name}`), db.atlas[name], ATLAS_COLUMNS[name], sorts[name], redraw);
    redraw();
  }
  const hw = () => drawTable(document.getElementById("hw-table"), db.devices, HW_COLUMNS, sorts.hw, hw);
  hw();
}

function measurementRows() {
  const q = state.q.trim().toLowerCase();
  return db.rows.filter((r) => (state.derived || r.evidence !== "derived") &&
    (!q || [r.measurement_id, r.device, r.modelName, r.quantization, r.engine, r.sourceTitle, r.notes, r.hardware_id, r.model_id, r.cache_state, r.cache_setup, r.spec_decoding]
      .some((v) => v && String(v).toLowerCase().includes(q))));
}

function renderMeasurements() {
  const rows = measurementRows();
  document.getElementById("m-count").textContent = `${rows.length} of ${db.rows.length} rows. Blank means the source did not state it; the notes say why.`;
  drawTable(document.getElementById("m-table"), rows, M_COLUMNS, sorts.m, renderMeasurements);
}

function drawTable(table, rows, columns, sort, redraw) {
  const value = (r, c) => (c.get ? c.get(r) : r[c.key]);
  const data = rows.slice();
  if (sort.key) {
    const c = columns.find((col) => col.key === sort.key);
    data.sort((a, b) => {
      const x = value(a, c), y = value(b, c);
      if (x == null) return 1;
      if (y == null) return -1;
      return sort.dir * (typeof x === "number" ? x - y : String(x).localeCompare(String(y)));
    });
  }
  const head = el("tr");
  for (const c of columns) {
    const th = el("th", c.num ? "num" : "", c.label);
    th.scope = "col";
    if (sort.key === c.key) th.setAttribute("aria-sort", sort.dir > 0 ? "ascending" : "descending");
    th.addEventListener("click", () => {
      sort.dir = sort.key === c.key ? -sort.dir : (c.num ? -1 : 1);
      sort.key = c.key;
      redraw();
    });
    head.append(th);
  }
  const body = data.map((r) => {
    const tr = el("tr");
    for (const c of columns) {
      const v = value(r, c);
      const td = el("td", c.num ? "num" : "");
      if (c.badge) td.append(el("span", "badge", EVIDENCE_LABEL[v] ?? v));
      else if (c.link && r[c.link]) {
        const a = el("a", "", truncate(v ?? "", 40));
        a.href = r[c.link];
        a.rel = "noopener";
        a.title = v ?? "";
        td.append(a);
      } else if (c.notes) {
        td.className = "notes";
        const details = el("details");
        details.append(el("summary", "", truncate(v ?? "", 80)), el("div", "", v ?? ""));
        td.append(details);
      } else td.textContent = v == null ? "" : c.num && !c.raw ? num(v) : String(v);
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
    "decode_tok_s_per_user", "ttft_ms", "power_w", "task_time_s", "cache_state", "cache_setup",
    "spec_decoding", "kv_pool_tokens", "cache_hit_ratio", "cached_input_tokens", "uncached_input_tokens",
    "source_id", "evidence", "notes"];
  const csv = d3.csvFormat(measurementRows().map((r) => ({...Object.fromEntries(fields.map((f) => [f, r[f] ?? ""])), source_url: r.sourceUrl ?? ""})));
  const a = el("a");
  a.href = URL.createObjectURL(new Blob([csv + "\n"], {type: "text/csv"}));
  a.download = "inference-data-measurements.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- agentic tab ---------- */

// The cloud measures are step durations by step_kind, plus the token rate of
// the read and write steps (estimated tokens / self-timed seconds).
const CLOUD_MEASURES = [
  {key: "read", label: "Read time", unit: "s", kinds: ["read"], value: (r) => r.duration_s},
  {key: "write_1", label: "Write time, step 3 (write_1)", unit: "s", kinds: ["write_1"], value: (r) => r.duration_s},
  {key: "write_2", label: "Write time, step 6 (write_2)", unit: "s", kinds: ["write_2"], value: (r) => r.duration_s},
  {key: "ping_1", label: "Ping time, step 4 (ping_1)", unit: "s", kinds: ["ping_1"], value: (r) => r.duration_s},
  {key: "ping_2", label: "Ping time, step 5 (ping_2)", unit: "s", kinds: ["ping_2"], value: (r) => r.duration_s},
  {key: "corpus", label: "Corpus step time", unit: "s", kinds: ["corpus"], value: (r) => r.duration_s},
  {key: "write_rate", label: "Write throughput", unit: "tokens/s", kinds: ["write_1", "write_2"],
    value: (r) => (r.write_tokens_est > 0 && r.duration_s > 0 ? r.write_tokens_est / r.duration_s : null),
    note: "Estimated tokens written (bytes / 4) divided by the self-timed duration of the write steps, so it includes thinking and tool overhead."},
  {key: "read_rate", label: "Read throughput", unit: "tokens/s", kinds: ["read"],
    value: (r) => (r.read_tokens_est > 0 && r.duration_s > 0 ? r.read_tokens_est / r.duration_s : null),
    note: "Estimated tokens read (bytes / 4) divided by the self-timed duration of the read steps."},
];

// D is the long-decode cell group of the box runs, the only one with a decode rate.
const DECODE_GROUP = "D";
const BOX_MEASURES = [
  {key: "ttft_ms", label: "Time to first token", unit: "ms", value: (r) => r.ttft_ms, note: "Time to first token seen by the proxy."},
  {key: "decode_tps", label: "Decode rate", unit: "tok/s", value: (r) => (cellGroup(r.cell) === DECODE_GROUP ? r.decode_tps : null),
    note: "Output tokens per second between the first and last token, on the long-decode (D) cells only."},
  {key: "turn_ms", label: "Request time", unit: "ms", value: (r) => r.turn_ms, note: "Whole request, from send to the last token."},
  {key: "cache_ratio", label: "Cache ratio", unit: "fraction of prompt", domain: [0, 1], value: (r) => r.cache_ratio,
    note: "Share of the prompt tokens read from the prompt cache, from the API usage counts."},
];

const natural = (a, b) => String(a).localeCompare(String(b), "en", {numeric: true});
const cellGroup = (cell) => String(cell).split("_")[0];
// Orange is kept for excluded rows.
const MODEL_COLORS = ["--series-1", "--series-3", "--series-4", "--series-7", "--series-5", "--series-6"];
const modelColor = (models, model) => css(MODEL_COLORS[models.indexOf(model) % MODEL_COLORS.length]);
const platformName = (p) => p.replaceAll("_", " ");

function fillSelect(select, options) {
  select.replaceChildren(...options.map(([value, label]) => {
    const o = el("option", "", label);
    o.value = value;
    return o;
  }));
}

function wireAgentic() {
  const a = state.ag;
  const cloud = document.getElementById("ag-measure"), box = document.getElementById("ag-box-measure"), platform = document.getElementById("ag-platform");
  fillSelect(cloud, CLOUD_MEASURES.map((m) => [m.key, `${m.label} (${m.unit})`]));
  fillSelect(box, BOX_MEASURES.map((m) => [m.key, `${m.label} (${m.unit})`]));
  fillSelect(platform, [["all", "All platforms"], ...[...new Set(db.agentic.cloud.rows.map((r) => r.platform))].sort().map((p) => [p, platformName(p)])]);
  a.measure = CLOUD_MEASURES[0].key;
  a.boxMeasure = BOX_MEASURES[0].key;
  cloud.addEventListener("change", () => { a.measure = cloud.value; render(); });
  box.addEventListener("change", () => { a.boxMeasure = box.value; render(); });
  platform.addEventListener("change", () => { a.platform = platform.value; render(); });
  document.getElementById("ag-dup").addEventListener("change", (e) => { a.dup = e.target.checked; render(); });
  document.getElementById("ag-excluded").addEventListener("change", (e) => { a.excluded = e.target.checked; render(); });
  for (const [id, key] of [["ag-split", "split"], ["ag-axis", "axis"]]) {
    for (const b of document.querySelectorAll(`#${id} button`)) b.addEventListener("click", () => { a[key] = b.dataset.v; render(); });
  }
  document.getElementById("ag-dvp-excluded").addEventListener("change", (e) => { a.dvpExcluded = e.target.checked; render(); });
  for (const b of document.querySelectorAll("#ag-dvp-y button")) b.addEventListener("click", () => { a.dvpY = b.dataset.v; render(); });
}

function renderCloud() {
  const a = state.ag, all = db.agentic.cloud.rows;
  const M = CLOUD_MEASURES.find((m) => m.key === a.measure);
  const models = [...new Set(all.map((r) => r.model))].sort(natural);
  // Cells run from the smallest context to the largest, the shorter output first.
  const outputSize = new Map(d3.rollups(all, (v) => d3.mean(v, (r) => r.write_bytes), (r) => r.output));
  const cellInfo = new Map(all.map((r) => [r.cell, r]));
  const cells = [...cellInfo.keys()].sort((x, y) => parseFloat(cellInfo.get(x).context) - parseFloat(cellInfo.get(y).context) ||
    outputSize.get(cellInfo.get(x).output) - outputSize.get(cellInfo.get(y).output));
  const rows = all.filter((r) => (a.platform === "all" || r.platform === a.platform) && !(a.dup && r.dup_step === "True") && M.kinds.includes(r.step_kind));
  const shown = [...d3.group(rows, (r) => r.model).keys()].sort((x, y) => d3.ascending(rows.find((r) => r.model === x).platform, rows.find((r) => r.model === y).platform) || natural(x, y));
  const pooled = a.split === "all";
  const cols = pooled ? [{key: null, label: "All cells pooled"}] : cells.map((c) => ({key: c, label: c}));
  const rowDefs = shown.map((m) => {
    const sample = rows.find((r) => r.model === m);
    return {key: m, label: m, sub: `${platformName(sample.platform)} · effort ${sample.effort}`};
  });
  document.getElementById("ag-cloud-note").textContent =
    `${M.label}, estimated and self-timed. ${M.note || "Duration the agent measured around the step, including model thinking and tool overhead."} One value per step: ${rows.length} steps in view.`;
  document.getElementById("ag-cloud-axis").textContent = `Horizontal axis: ${M.label.toLowerCase()} (${M.unit}), ${a.axis === "shared" ? "on the same scale in every chart" : "on its own scale in each chart"}. Vertical axis: number of steps. n is the number of steps in the chart, med its median.`;
  smallMultiples(document.getElementById("ag-cloud-grid"), {
    rows: rowDefs, cols, M, unit: M.unit, rowHead: "Model", axis: a.axis,
    series: (r, c) => {
      const vals = rows.filter((x) => x.model === r.key && (c.key == null || x.cell === c.key))
        .map((x) => ({v: M.value(x), tag: x.run_id})).filter((d) => Number.isFinite(d.v) && d.v >= 0);
      return [{name: "Steps", color: modelColor(models, r.key), items: vals}];
    },
  });
}

function renderBox() {
  const a = state.ag, all = db.agentic.box.rows.filter((r) => r.cell != null);
  const M = BOX_MEASURES.find((m) => m.key === a.boxMeasure);
  const models = [...new Set(all.map((r) => r.model_pinned))].sort(natural);
  const cells = [...new Set(all.filter((r) => Number.isFinite(M.value(r))).map((r) => r.cell))].sort(natural);
  const excluded = db.agentic.box.rows.filter((r) => r.excluded_reason != null);
  const why = d3.rollups(excluded, (v) => v.length, (r) => r.excluded_reason).sort((x, y) => y[1] - x[1]);
  document.getElementById("ag-excluded-count").textContent =
    `${excluded.length} of ${db.agentic.box.rows.length} rows excluded (${why.map(([k, n]) => `${n} ${k}`).join(", ")}): ${a.excluded ? "shown in orange" : "hidden"}.`;
  document.getElementById("ag-box-legend").replaceChildren(...[
    legendKey("Included rows", d3.symbolSquare, css(MODEL_COLORS[0])),
    ...(a.excluded ? [legendKey("Excluded rows", d3.symbolSquare, css("--series-2"))] : []),
  ]);
  document.getElementById("ag-box-note").textContent = `${M.label}, proxy-measured. ${M.note}`;
  document.getElementById("ag-box-axis").textContent = `Horizontal axis: ${M.label.toLowerCase()} (${M.unit}), ${a.axis === "shared" ? "on the same scale in every chart" : "on its own scale in each chart"}. Vertical axis: number of requests. n is the number of requests in the chart, med its median.`;
  smallMultiples(document.getElementById("ag-box-grid"), {
    rows: cells.map((c) => ({key: c, label: c, sub: ""})), cols: models.map((m) => ({key: m, label: m})), M, unit: M.unit, rowHead: "Cell", axis: a.axis,
    series: (r, c) => {
      const mine = all.filter((x) => x.cell === r.key && x.model_pinned === c.key);
      const pick = (list) => list.map((x) => ({v: M.value(x), tag: `${x.session_id} turn ${x.turn_index}`})).filter((d) => Number.isFinite(d.v));
      return [
        {name: "Included", color: modelColor(models, c.key), items: pick(mine.filter((x) => x.excluded_reason == null))},
        ...(a.excluded ? [{name: "Excluded", color: css("--series-2"), items: pick(mine.filter((x) => x.excluded_reason != null))}] : []),
      ];
    },
  });
}

/* ---------- decode vs prefill ---------- */

// Decode speed comes from the D cells, prefill speed from C0 (no cache) and C2
// (cache hit): prompt_tokens / TTFT, so cached tokens count as processed.
const DVP_SERIES = [
  {key: "C0", label: "Prefill, no cache", color: "--series-1", symbol: d3.symbolCircle},
  {key: "C2", label: "Prefill, cache hit", color: "--series-3", symbol: d3.symbolDiamond},
];

// Same quantile method everywhere: d3.quantile on sorted values.
function quartiles(values) {
  const v = values.slice().sort(d3.ascending);
  return v.length ? {n: v.length, med: d3.quantile(v, 0.5), p25: d3.quantile(v, 0.25), p75: d3.quantile(v, 0.75)} : null;
}

// "sonnet-5-5" -> "Sonnet 5.5"
function modelShort(name) {
  const parts = String(name).replace(/^claude-/, "").split("-");
  const ver = parts.filter((p) => /^\d+$/.test(p)).join(".");
  const word = parts.filter((p) => !/^\d+$/.test(p)).join(" ");
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}${ver ? ` ${ver}` : ""}`;
}

function dvpPoints() {
  const a = state.ag, rows = db.agentic.box.rows;
  const usable = rows.filter((r) => r.cell != null && r.model_pinned != null && (a.dvpExcluded || r.excluded_reason == null));
  const parsed = usable.map((r) => ({r, m: /^(D|C0|C2)_(\d+k)$/.exec(r.cell)})).filter((d) => d.m);
  const positive = (v) => Number.isFinite(v) && v > 0;
  const models = [...new Set(parsed.map((d) => d.r.model_pinned))].sort(natural);
  const ctxs = [...new Set(parsed.map((d) => d.m[2]))].sort(natural);
  const pick = (model, group, ctx, value) => parsed.filter((d) => d.r.model_pinned === model && d.m[1] === group && d.m[2] === ctx)
    .map((d) => value(d.r)).filter(positive);
  const out = [];
  for (const model of models) {
    for (const ctx of ctxs) {
      const dec = quartiles(pick(model, "D", ctx, (r) => r.decode_tps));
      for (const ser of DVP_SERIES) {
        const pre = quartiles(pick(model, ser.key, ctx, (r) => (positive(r.prompt_tokens) && positive(r.ttft_ms) ? r.prompt_tokens / (r.ttft_ms / 1000) : null)));
        out.push({model, ctx, ser, dec, pre, ok: Boolean(dec && pre), name: `${modelShort(model)} ${ctx}`});
      }
    }
  }
  return {models, ctxs, points: out};
}

function renderDecodeVsPrefill() {
  const a = state.ag, {points} = dvpPoints();
  const excluded = db.agentic.box.rows.filter((r) => r.excluded_reason != null);
  document.getElementById("ag-dvp-count").textContent =
    `${excluded.length} of ${db.agentic.box.rows.length} rows excluded: ${a.dvpExcluded ? "included in the medians" : "left out"}.`;
  for (const b of document.querySelectorAll("#ag-dvp-y button")) b.setAttribute("aria-pressed", String(b.dataset.v === a.dvpY));
  const missing = points.filter((p) => !p.ok);
  document.getElementById("ag-dvp-missing").textContent = missing.length
    ? `Missing, not plotted: ${missing.map((p) => `${p.name} (${p.ser.label.toLowerCase()})`).join(", ")}.` : "";
  document.getElementById("ag-dvp-legend").replaceChildren(...DVP_SERIES.map((s) => legendKey(s.label, s.symbol, css(s.color))));
  document.getElementById("ag-dvp-note").textContent =
    "Prefill speed is end to end: TTFT includes network, queueing and API overhead, so it is a lower bound on true prefill throughput. " +
    "Prompt tokens are the prompt_tokens column (input + cache creation + cache read tokens); for a cache hit the effective prefill counts cached tokens as processed. " +
    "Decode is decode_tps from the D cells (long-decode runs); the same decode value is used for both series. Medians, with p25 to p75 bars, computed in the browser from the CSV.";
  drawDvpChart(document.getElementById("ag-dvp-chart"), points.filter((p) => p.ok), a.dvpY === "log");
  const range = (q) => `${num(q.p25)}–${num(q.p75)}`;
  const cellText = (q) => (q ? `${num(q.med)} (${range(q)}, n=${q.n})` : "missing");
  const columns = [
    {key: "model", label: "Model", get: (p) => modelShort(p.model)}, {key: "ctx", label: "Context"}, {key: "series", label: "Series", get: (p) => p.ser.label},
    {key: "dec", label: "Decode median tok/s (p25–p75, n)", get: (p) => cellText(p.dec)},
    {key: "pre", label: "Prefill median tok/s (p25–p75, n)", get: (p) => cellText(p.pre)},
  ];
  const t = document.getElementById("t-ag-dvp");
  const head = el("tr");
  for (const c of columns) { const th = el("th", "", c.label); th.scope = "col"; head.append(th); }
  const body = points.map((p) => {
    const tr = el("tr");
    for (const c of columns) tr.append(el("td", "", c.get ? c.get(p) : p[c.key]));
    return tr;
  });
  t.replaceChildren(el("thead"), el("tbody"));
  t.tHead.append(head);
  t.tBodies[0].append(...body);
}

function drawDvpChart(box, pts, logY) {
  box.replaceChildren();
  if (!pts.length) return box.append(el("p", "empty", "No complete model and context pairs."));
  const W = Math.max(320, box.clientWidth), H = 460;
  const m = {t: 16, r: 24, b: 48, l: 64};
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const xs = pts.flatMap((p) => [p.dec.p25, p.dec.p75]), ys = pts.flatMap((p) => [p.pre.p25, p.pre.p75]);
  const xd = d3.scaleLinear().domain([Math.max(0, d3.min(xs) * 0.9), d3.max(xs) * 1.1]).nice();
  const x = xd.range([m.l, m.l + iw]);
  const y = (logY ? d3.scaleLog().domain([d3.min(ys) / 1.3, d3.max(ys) * 1.3]) : d3.scaleLinear().domain([0, d3.max(ys) * 1.08]).nice()).range([ih, 0]);
  const muted = css("--text-secondary");
  const svg = d3.select(box).append("svg").attr("width", "100%").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img")
    .attr("aria-label", "Prefill speed against decode speed, by model, context and cache state")
    .style("font", "12px system-ui, -apple-system, 'Segoe UI', sans-serif");
  const g = svg.append("g").attr("transform", `translate(0,${m.t})`);
  const yt = logY ? logTicks(y.domain()[0], y.domain()[1]) : y.ticks(6);
  g.selectAll("line.grid").data(yt).join("line").attr("x1", m.l).attr("x2", m.l + iw).attr("y1", y).attr("y2", y).attr("stroke", css("--grid"));
  g.selectAll("text.yt").data(yt).join("text").attr("x", m.l - 6).attr("y", (d) => y(d) + 4).attr("text-anchor", "end").attr("fill", muted).text(tickFormat);
  const xt = x.ticks(8);
  g.selectAll("text.xt").data(xt).join("text").attr("x", x).attr("y", ih + 18).attr("text-anchor", "middle").attr("fill", muted).text(tickFormat);
  g.append("line").attr("x1", m.l).attr("x2", m.l + iw).attr("y1", ih).attr("y2", ih).attr("stroke", css("--axis"));
  g.append("text").attr("x", m.l + iw / 2).attr("y", ih + 40).attr("text-anchor", "middle").attr("fill", muted).text("Decode speed (tokens/s, median)");
  g.append("text").attr("transform", `translate(14,${ih / 2}) rotate(-90)`).attr("text-anchor", "middle").attr("fill", muted)
    .text(`Prefill speed (tokens/s, median${logY ? ", log scale" : ""})`);
  // Thin line between the no-cache and cache-hit points of one model and context.
  const pairs = d3.group(pts, (p) => p.name);
  for (const [, two] of pairs) {
    if (two.length < 2) continue;
    g.append("line").attr("x1", x(two[0].dec.med)).attr("y1", y(two[0].pre.med)).attr("x2", x(two[1].dec.med)).attr("y2", y(two[1].pre.med))
      .attr("stroke", muted).attr("stroke-width", 1).attr("stroke-opacity", 0.6);
  }
  const tip = document.getElementById("tip");
  const stat = (q) => `${num(q.med)} (p25 ${num(q.p25)}, p75 ${num(q.p75)}, n=${q.n})`;
  for (const p of pts) {
    const color = css(p.ser.color), cx = x(p.dec.med), cy = y(p.pre.med);
    const pt = g.append("g").attr("tabindex", 0).attr("role", "img").style("outline", "none")
      .attr("aria-label", `${p.name}, ${p.ser.label}: decode ${num(p.dec.med)} tok/s, prefill ${num(p.pre.med)} tok/s`);
    pt.append("line").attr("x1", x(p.dec.p25)).attr("x2", x(p.dec.p75)).attr("y1", cy).attr("y2", cy).attr("stroke", color).attr("stroke-width", 1.4);
    pt.append("line").attr("x1", cx).attr("x2", cx).attr("y1", y(p.pre.p25)).attr("y2", y(p.pre.p75)).attr("stroke", color).attr("stroke-width", 1.4);
    pt.append("path").attr("d", d3.symbol(p.ser.symbol, 90)()).attr("transform", `translate(${cx},${cy})`).attr("fill", color).attr("stroke", css("--surface-1"));
    pt.append("text").attr("class", "dvp-point").attr("x", cx + 9).attr("y", p.ser.key === "C0" ? cy - 8 : cy + 15).attr("fill", css("--text-primary")).style("font-size", "11px").text(p.name);
    const show = (event) => {
      fillTip(tip, [["t", `${p.name} · ${p.ser.label}`], ["r", "Decode tok/s", stat(p.dec)], ["r", "Prefill tok/s", stat(p.pre)]]);
      const r = event.currentTarget.getBoundingClientRect();
      placeTip(tip, r.x + r.width / 2, r.y);
    };
    pt.on("pointerenter", show).on("pointerleave", () => { tip.hidden = true; }).on("focus", show).on("blur", () => { tip.hidden = true; });
  }
}

// Rows by columns of small histograms. Each cell asks `series(row, col)` for
// stacked series of {v, tag} items; the horizontal scale is shared or per chart.
function smallMultiples(host, spec) {
  const {rows, cols, M} = spec;
  const cell = rows.map((r) => cols.map((c) => spec.series(r, c)));
  const pooled = cell.flat(2).flatMap((s) => s.items.map((d) => d.v));
  const hi = M.domain ? M.domain[1] : d3.max(pooled) ?? 1;
  const colW = cols.length > 7 ? 150 : cols.length > 3 ? 120 : 240;
  const grid = el("div", "sm-grid");
  grid.style.gridTemplateColumns = `9.5rem repeat(${cols.length}, minmax(${colW}px, 1fr))`;
  grid.append(el("div", "sm-head", spec.rowHead), ...cols.map((c) => el("div", "sm-head", c.label)));
  const boxes = [];
  rows.forEach((r, i) => {
    const label = el("div", "sm-row");
    label.append(el("strong", "", r.label));
    if (r.sub) label.append(document.createTextNode(r.sub));
    grid.append(label);
    cols.forEach((c, j) => {
      const box = el("div", "sm-cell");
      grid.append(box);
      boxes.push([box, cell[i][j]]);
    });
  });
  host.replaceChildren(grid);
  if (!rows.length) return host.replaceChildren(el("p", "empty", "No rows for this selection."));
  for (const [box, series] of boxes) {
    const own = d3.max(series.flatMap((s) => s.items.map((d) => d.v))) ?? 1;
    drawHist(box, series, {domain: spec.axis === "shared" ? [0, hi] : [0, M.domain ? M.domain[1] : own], unit: spec.unit, fixed: M.domain});
  }
}

const tickFormat = (v) => (Math.abs(v) >= 1000 ? d3.format("~s")(v) : d3.format("~g")(v));

function drawHist(box, series, opt) {
  box.replaceChildren();
  const all = series.flatMap((s) => s.items.map((d) => d.v));
  if (!all.length) return box.append(el("p", "empty", "n = 0"));
  const W = Math.max(100, box.clientWidth), H = 96;
  const m = {t: 14, r: 6, b: 20, l: 24};
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const hi = opt.domain[1] > 0 ? opt.domain[1] : 1;
  const step = opt.fixed ? hi / 10 : d3.tickStep(0, hi, 10);
  const edges = d3.range(0, hi + step * 0.999, step).map((v) => +v.toPrecision(12));
  const bin = d3.bin().domain([0, edges[edges.length - 1]]).thresholds(edges.slice(1, -1));
  const binned = series.map((s) => bin(s.items.map((d) => d.v)));
  const itemsOf = (s, b) => s.items.filter((d) => d.v >= b.x0 && (b.x1 === edges[edges.length - 1] ? d.v <= b.x1 : d.v < b.x1));
  const x = d3.scaleLinear().domain([0, edges[edges.length - 1]]).range([m.l, m.l + iw]);
  const total = binned[0].map((_, k) => d3.sum(binned, (b) => b[k].length));
  const ymax = Math.max(1, d3.max(total));
  const y = d3.scaleLinear().domain([0, ymax]).range([ih, 0]);
  const muted = css("--text-secondary");
  const svg = d3.select(box).append("svg").attr("width", "100%").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img")
    .attr("aria-label", `Histogram of ${all.length} values`).style("font", "11px system-ui, -apple-system, 'Segoe UI', sans-serif");
  const g = svg.append("g").attr("transform", `translate(0,${m.t})`);
  const yt = d3.ticks(0, ymax, 3).filter(Number.isInteger);
  g.selectAll("line.grid").data(yt).join("line").attr("x1", m.l).attr("x2", m.l + iw).attr("y1", y).attr("y2", y).attr("stroke", css("--grid"));
  g.selectAll("text.yt").data(yt).join("text").attr("x", m.l - 4).attr("y", (d) => y(d) + 4).attr("text-anchor", "end").attr("fill", muted).text(String);
  g.append("line").attr("x1", m.l).attr("x2", m.l + iw).attr("y1", ih).attr("y2", ih).attr("stroke", css("--axis"));
  const xt = x.ticks(iw < 150 ? 3 : 5);
  g.selectAll("text.xt").data(xt).join("text").attr("x", x).attr("y", ih + 14).attr("text-anchor", "middle").attr("fill", muted).text(tickFormat);
  const tip = document.getElementById("tip");
  const surface = css("--surface-1");
  total.forEach((n, k) => {
    if (!n) return;
    const x0 = edges[k], x1 = edges[k + 1];
    let acc = 0;
    const bar = g.append("g").attr("tabindex", 0).attr("role", "img").style("outline", "none")
      .attr("aria-label", `${tickFormat(x0)} to ${tickFormat(x1)} ${opt.unit}: ${n}`);
    series.forEach((s, si) => {
      const c = binned[si][k].length;
      if (!c) return;
      bar.append("rect").attr("x", x(x0) + 0.5).attr("width", Math.max(1, x(x1) - x(x0) - 1))
        .attr("y", y(acc + c)).attr("height", y(acc) - y(acc + c)).attr("fill", s.color).attr("stroke", surface).attr("stroke-width", 0.5);
      acc += c;
    });
    const rowsTip = () => [
      ["t", `${num(x0)} to ${num(x1)} ${opt.unit}`],
      ...series.map((s) => ["r", s.name, String(binned[series.indexOf(s)][k].length)]).filter((r) => r[2] !== "0"),
      ...series.flatMap((s) => itemsOf(s, {x0, x1}).slice(0, 5).map((d) => ["s", `${num(d.v)} · ${d.tag}`])),
    ];
    const show = (event) => {
      fillTip(tip, rowsTip());
      const r = event.currentTarget.getBoundingClientRect();
      placeTip(tip, r.x + r.width / 2, r.y);
    };
    bar.on("pointerenter", show).on("pointerleave", () => { tip.hidden = true; }).on("focus", show).on("blur", () => { tip.hidden = true; });
  });
  const med = d3.median(all);
  g.append("text").attr("x", m.l + iw).attr("y", -3).attr("text-anchor", "end").attr("fill", muted)
    .text(`n = ${all.length}${all.length > 1 ? ` · med ${num(med)}` : ""} ${opt.unit}`);
}

function renderAgenticData() {
  for (const [key, id, sortKey, counter] of [["cloud", "t-ag-cloud", "agCloud", "ag-rows-cloud"], ["box", "t-ag-box", "agBox", "ag-rows-box"]]) {
    const t = db.agentic[key];
    const columns = t.fields.map((f) => ({key: f.name, label: f.name, num: f.type === "number" || f.type === "integer", raw: true}));
    document.getElementById(counter).textContent = `${t.rows.length} rows.`;
    const redraw = () => drawTable(document.getElementById(id), t.rows, columns, sorts[sortKey], redraw);
    redraw();
  }
}

/* ---------- helpers ---------- */

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function el(tag, className = "", text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function num(v) {
  return typeof v === "number" ? v.toLocaleString("en", {maximumFractionDigits: Math.abs(v) < 10 ? 2 : 1}) : v;
}

function short(v) {
  return d3.format("~s")(v).replace("G", "B");
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
