/* Inference data explorer. Reads the CSV tables next to this page, types them
   with datapackage.json, and draws with d3. All labels come from the CSVs, so
   they are inserted with textContent or d3 .text(), never innerHTML. */

"use strict";

const TABLES = ["sources", "hardware", "models", "measurements"];
const ATLAS = ["gpus", "systems", "measures", "models"];
const ATLAS_NUMERIC = new Set(["price_usd", "memory_gb", "bandwidth_gbs", "tflops_bf16", "power_w", "gpus", "users",
  "decode_tps", "prefill_tps", "prefill_tokens", "aa_index", "weights_gb", "total_params_b", "active_params_b"]);
const SUBS = {memory: "hardware", bandwidth: "hardware", compute: "hardware", "hardware-data": "hardware", "inference-data": "inference"};
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

const state = {sub: "memory", lastHardware: "memory", x: "log", y: "log", q: "", derived: false};
const sorts = {hw: {key: "bandwidth_gb_s", dir: -1}, m: {key: null, dir: 1}, gpus: {key: null, dir: 1}, systems: {key: null, dir: 1}, measures: {key: null, dir: 1}, models: {key: "aa_index", dir: -1}};
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
}

function go(sub) {
  if (location.hash.slice(1) === sub) return render();
  location.hash = sub;
}

function wire() {
  for (const b of document.querySelectorAll(".tabs button")) {
    b.addEventListener("click", () => go(b.dataset.tab === "inference" ? "inference-data" : state.lastHardware));
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
    (!q || [r.measurement_id, r.device, r.modelName, r.quantization, r.engine, r.sourceTitle, r.notes, r.hardware_id, r.model_id]
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
      } else td.textContent = v == null ? "" : c.num ? num(v) : v;
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
    "decode_tok_s_per_user", "ttft_ms", "power_w", "task_time_s", "source_id", "evidence", "notes"];
  const csv = d3.csvFormat(measurementRows().map((r) => ({...Object.fromEntries(fields.map((f) => [f, r[f] ?? ""])), source_url: r.sourceUrl ?? ""})));
  const a = el("a");
  a.href = URL.createObjectURL(new Blob([csv + "\n"], {type: "text/csv"}));
  a.download = "inference-data-measurements.csv";
  a.click();
  URL.revokeObjectURL(a.href);
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
