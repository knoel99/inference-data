/* Inference data explorer. Reads the CSV tables next to this page, types them
   with datapackage.json, and draws with d3. All labels come from the CSVs, so
   they are inserted with textContent or d3 .text(), never innerHTML. */

"use strict";

const TABLES = ["sources", "hardware", "models", "measurements"];
const SUBS = {memory: "hardware", bandwidth: "hardware", compute: "hardware", "hardware-data": "hardware", "inference-data": "inference"};
const EVIDENCE_LABEL = {
  measured_by_source: "measured",
  vendor_claim: "vendor claim",
  unverified_claim: "unverified",
  derived: "derived",
};

// Families are a display grouping for shape and colour. hardware.csv has no
// family column yet, so the grouping is read from the stable hardware ids.
const FAMILIES = [
  {k: "geforce", scale: "gpu", label: "GeForce RTX", test: /^nvidia-rtx-\d/},
  {k: "rtxpro", scale: "gpu", label: "RTX PRO Blackwell", test: /^nvidia-rtx-pro-/},
  {k: "radeonpro", scale: "gpu", label: "Radeon AI PRO", test: /^amd-radeon-ai-pro/},
  {k: "nvhbm", scale: "gpu", label: "NVIDIA HBM datacenter", test: /^nvidia-(b\d|gb\d|h\d)/},
  {k: "unified", scale: "sys", label: "Unified-memory mini PC or laptop", test: /^(nvidia-dgx-spark|nvidia-rtx-spark|amd-ryzen-ai)/},
  {k: "apple", scale: "sys", label: "Apple silicon", test: /^apple-/},
  {k: "station", scale: "sys", label: "DGX Station GB300", test: /^nvidia-dgx-station/},
  {k: "othergpu", scale: "gpu", label: "Other GPU", test: /./},
];
const SYMBOLS = [d3.symbolCircle, d3.symbolTriangle, d3.symbolDiamond, d3.symbolSquare, d3.symbolCross, d3.symbolWye, d3.symbolStar];

const CAPS = {
  memory: {
    col: "memory_gb", label: "Memory (GB)", unit: "GB", title: "Memory",
    note: "GB of memory, summed over the machine at computer scale. Diagonals give the price per GB or the GB per kW.",
  },
  bandwidth: {
    col: "bandwidth_gb_s", label: "Memory bandwidth (GB/s)", unit: "GB/s", title: "Bandwidth",
    note: "GB/s of memory bandwidth. Diagonals give the price per GB/s or the GB/s per watt.",
  },
  compute: {
    col: "dense_bf16_fp16_tflops", label: "Dense 16-bit TFLOPS", unit: "TFLOPS", title: "Compute",
    note: "Dense BF16 or FP16 tensor TFLOPS as the vendor states them. Diagonals give the price per TFLOPS or the TFLOPS per kW.",
  },
};

// Diagonals of a constant ratio y / x, keyed by "<x>-<capability>".
const RATIOS = {
  "price-memory": {at: (x, b) => x / b, base: [1, 10, 100, 1000], label: (b) => `$${num(b)} per GB`},
  "price-bandwidth": {at: (x, b) => x / b, base: [0.1, 1, 10, 100], label: (b) => `$${num(b)} per GB/s`},
  "price-compute": {at: (x, b) => x / b, base: [1, 10, 100, 1000], label: (b) => `$${num(b)} per TFLOPS`},
  "power-memory": {at: (x, b) => (x * b) / 1000, base: [10, 100, 1000], label: (b) => `${num(b)} GB per kW`},
  "power-bandwidth": {at: (x, b) => x * b, base: [1, 3, 10], label: (b) => `${num(b)} GB/s per W`},
  "power-compute": {at: (x, b) => (x * b) / 1000, base: [100, 1000], label: (b) => `${num(b)} TFLOPS per kW`},
  decode: {at: (x, b) => x / b, base: [1, 3, 10, 30, 100], label: (b) => `${num(b)} GB read per token`},
  prefill: {at: (x, b) => x * b, base: [1, 10, 100], label: (b) => `${num(b)} tok/s per TFLOPS`},
};

const state = {sub: "memory", lastHardware: "memory", x: "log", y: "log", q: "", derived: false};
const sorts = {hw: {key: "bandwidth_gb_s", dir: -1}, m: {key: null, dir: 1}};
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
  db = index(tables);
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

function typed(row, types) {
  const out = {};
  for (const [key, raw] of Object.entries(row)) {
    if (raw === "") out[key] = null;
    else if (types[key] === "integer" || types[key] === "number") out[key] = +raw;
    else out[key] = raw;
  }
  return out;
}

function index(t) {
  const sources = new Map(t.sources.map((s) => [s.source_id, s]));
  const models = new Map(t.models.map((m) => [m.model_id, m]));
  for (const scale of ["gpu", "sys"]) {
    FAMILIES.filter((f) => f.scale === scale).forEach((f, i) => { f.slot = i; f.symbol = SYMBOLS[i]; });
  }
  const devices = t.hardware.map((h) => {
    const src = sources.get(h.source_id);
    return {
      ...h,
      fam: FAMILIES.find((f) => f.test.test(h.hardware_id)),
      short: shortName(h.name),
      price: h.market_price_usd ?? h.launch_price_usd,
      priceBasis: h.market_price_usd != null ? `market price${h.market_price_date ? " on " + h.market_price_date : ""}` : h.launch_price_usd != null ? "launch price" : null,
      sourceTitle: src ? src.title : h.source_id,
      sourceUrl: src ? src.url : null,
    };
  });
  const hardware = new Map(devices.map((d) => [d.hardware_id, d]));
  const rows = t.measurements.map((m) => {
    const hw = hardware.get(m.hardware_id);
    const model = models.get(m.model_id);
    const src = sources.get(m.source_id);
    return {
      ...m, hw,
      device: hw ? (m.hw_count > 1 ? `${hw.short} ×${m.hw_count}` : hw.short) : "Unidentified device",
      modelName: model ? model.name : "Unidentified model",
      sourceTitle: src ? src.title : m.source_id,
      sourceUrl: src ? src.url : null,
      sourceDate: src ? src.date_published : null,
    };
  });
  return {sources, models, devices, hardware, rows};
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
  for (const seg of document.querySelectorAll(".seg")) {
    for (const b of seg.querySelectorAll("button")) {
      b.addEventListener("click", () => { state[seg.dataset.axis] = b.dataset.s; render(); });
    }
  }
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
  for (const seg of document.querySelectorAll(".seg")) {
    for (const b of seg.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.s === state[seg.dataset.axis]));
  }
  const isCap = Boolean(CAPS[state.sub]);
  document.getElementById("capability").hidden = !isCap;
  document.getElementById("axes").hidden = !isCap;
  document.getElementById("hardware-data").hidden = state.sub !== "hardware-data";
}

// Only the visible view renders: charts size themselves to their container,
// which has no width while hidden.
function render() {
  syncNav();
  if (CAPS[state.sub]) renderCapability(state.sub);
  else if (state.sub === "hardware-data") renderDeviceTable();
  else renderMeasurements();
}

/* ---------- capability tabs ---------- */

function renderCapability(cap) {
  const C = CAPS[cap];
  document.getElementById("cap-note").textContent = C.note;
  drawFamilyLegend(document.getElementById("leg-gpu"), "gpu");
  drawFamilyLegend(document.getElementById("leg-sys"), "sys");
  for (const scale of ["gpu", "sys"]) {
    const devices = db.devices.filter((d) => d.fam.scale === scale);
    const what = scale === "gpu" ? "a GPU" : "a computer";
    for (const [xk, xLabel, xget] of [["price", "Price (US dollars)", (d) => d.price], ["power", "Power (W)", (d) => d.tdp_w]]) {
      document.getElementById(`t-${scale}-${xk}`).textContent = `${C.title} of ${what} against its ${xk}`;
      const items = devices.map((d) => ({x: xget(d), y: d[C.col], label: d.short, fam: d.fam, tip: deviceTip(d)}));
      scatter(`${scale}-${xk}`, items, {
        xLabel, yLabel: C.label, xMoney: xk === "price", ratio: RATIOS[`${xk}-${cap}`],
        missingText: (names) => `Not drawn, no stated ${xk} or ${C.title.toLowerCase()}: ${names.join(", ")}.`,
      });
    }
  }
  renderYield(cap);
}

function deviceTip(d) {
  const rows = [["t", d.name], ["s", d.fam.label]];
  if (d.price != null) rows.push(["r", "Price", `$${num(d.price)}`]);
  if (d.memory_gb != null) rows.push(["r", "Memory", `${num(d.memory_gb)} GB`]);
  if (d.bandwidth_gb_s != null) rows.push(["r", "Bandwidth", `${num(d.bandwidth_gb_s)} GB/s`]);
  if (d.dense_bf16_fp16_tflops != null) rows.push(["r", "Dense 16-bit", `${num(d.dense_bf16_fp16_tflops)} TFLOPS`]);
  if (d.tdp_w != null) rows.push(["r", "Power", `${num(d.tdp_w)} W`]);
  if (d.priceBasis) rows.push(["s", `Price: ${d.priceBasis}`]);
  rows.push(["s", `Source: ${d.sourceTitle}`]);
  return rows;
}

// What the capability buys, from measurements.csv. Memory has no such chart
// yet: it needs model weight sizes, which models.csv does not hold.
function renderYield(cap) {
  const block = document.getElementById("yield-block");
  block.hidden = cap === "memory";
  if (cap === "memory") return;
  const bw = cap === "bandwidth";
  const metric = bw ? "decode_tok_s" : "prefill_tok_s";
  document.getElementById("yield-group").textContent = bw ? "What bandwidth buys: generation speed" : "What compute buys: prefill speed";
  document.getElementById("t-yield").textContent = bw ? "Measured generation against bandwidth" : "Measured prefill against compute";
  document.getElementById("n-yield").textContent = bw
    ? "Single-request decode (concurrency 1) from measurements.csv, against the summed bandwidth of the devices used. To produce each token the machine rereads the active weights: the diagonals give the GB read per token that each point implies, so one model should follow one diagonal. Speculative decoding validates several tokens per read and can beat that limit; the row notes say when it was on."
    : "Single-request prefill (concurrency 1) from measurements.csv, against the summed dense 16-bit TFLOPS of the devices used. Prefill processes the whole prompt at once and is bound by compute. Diagonals give tokens per second per TFLOPS; FP8 or FP4 models beat what the 16-bit figure suggests, and long prompts cost more per token.";
  const rows = db.rows.filter((r) => r.evidence !== "derived" && r.concurrency === 1 && r[metric] != null);
  const used = (r) => (r.hw && r.hw[CAPS[cap].col] != null ? r.hw[CAPS[cap].col] * (r.hw_count || 1) : null);
  // Colour follows the model: the most frequent drawn models take the slots.
  const ranked = d3.groupSort(rows.filter((r) => used(r) != null && r.model_id), (v) => -v.length, (r) => r.model_id);
  const fams = new Map(ranked.slice(0, 7).map((id, i) => [id, {label: db.models.get(id).name, slot: i, symbol: SYMBOLS[i]}]));
  const other = {label: "Other models", slot: -1, symbol: d3.symbolCircle};
  const items = rows.map((r) => ({
    x: used(r), y: r[metric], label: r.device, fam: fams.get(r.model_id) || other,
    tip: [
      ["t", r.device],
      ["s", [r.modelName, r.quantization, r.engine].filter(Boolean).join(" · ")],
      ["r", bw ? "Bandwidth used" : "TFLOPS used", used(r) == null ? "not stated" : `${num(used(r))} ${CAPS[cap].unit}`],
      ["r", bw ? "Decode" : "Prefill", `${num(r[metric])} tok/s`],
      ...(r.input_tokens != null ? [["r", "Prompt", `${num(r.input_tokens)} tokens`]] : []),
      ["s", `Evidence: ${EVIDENCE_LABEL[r.evidence]}`],
      ["s", `Source: ${r.sourceTitle}`],
    ],
  }));
  const keys = [...fams.values()];
  if (items.some((i) => i.fam === other && i.x != null)) keys.push(other);
  document.getElementById("leg-yield").replaceChildren(...keys.map(legendKey));
  scatter("yield", items, {
    xLabel: bw ? "Summed memory bandwidth of the devices used (GB/s)" : "Summed dense 16-bit TFLOPS of the devices used",
    yLabel: bw ? "Decode for one request (tok/s)" : "Prefill for one request (tok/s)",
    ratio: RATIOS[bw ? "decode" : "prefill"],
    labelOnce: true,
    missingText: (names) => `${names.length} result${names.length > 1 ? "s" : ""} not drawn because hardware.csv states no ${bw ? "bandwidth" : "dense TFLOPS"} for the device: ${[...new Set(names)].join(", ")}.`,
  });
}

function drawFamilyLegend(box, scale) {
  const present = new Set(db.devices.filter((d) => d.fam.scale === scale).map((d) => d.fam));
  box.replaceChildren(...FAMILIES.filter((f) => present.has(f)).map(legendKey));
}

function legendKey(f) {
  const s = el("span");
  const svg = d3.create("svg").attr("width", 14).attr("height", 14).attr("viewBox", "-7 -7 14 14").attr("aria-hidden", "true");
  svg.append("path").attr("d", d3.symbol(f.symbol, 64)()).attr("fill", color(f));
  s.append(svg.node(), document.createTextNode(f.label));
  return s;
}

function color(f) {
  return f.slot >= 0 && f.slot < 7 ? css(`--series-${f.slot + 1}`) : css("--series-other");
}

/* ---------- the scatter ---------- */

function scatter(id, items, opt) {
  const box = document.getElementById(`c-${id}`);
  const missBox = document.getElementById(`x-${id}`);
  const lgx = state.x === "log", lgy = state.y === "log";
  const pts = items.filter((p) => p.x > 0 && p.y > 0);
  const miss = items.filter((p) => !(p.x > 0 && p.y > 0)).map((p) => p.label);
  missBox.textContent = miss.length ? opt.missingText(miss) : "";
  box.replaceChildren();
  if (!pts.length) return box.append(el("p", "empty", "No point has both values yet."));

  const W = Math.max(300, box.clientWidth || 800);
  const H = Math.round(Math.min(520, Math.max(320, W * 0.62)));
  const m = {t: 22, r: 16, b: 44, l: 58};
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const dom = (vals, lg) => (lg ? [d3.min(vals) / 1.6, d3.max(vals) * 1.6] : [0, d3.max(vals) * 1.1]);
  const x = (lgx ? d3.scaleLog() : d3.scaleLinear()).domain(dom(pts.map((p) => p.x), lgx)).range([0, iw]);
  const y = (lgy ? d3.scaleLog() : d3.scaleLinear()).domain(dom(pts.map((p) => p.y), lgy)).range([ih, 0]);
  if (!lgx) x.nice();
  if (!lgy) y.nice();
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
  const labels = g.append("g").attr("pointer-events", "none");
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
      labels.append("text").attr("transform", `translate(${pB[0] - 4},${pB[1] + 12}) rotate(${angle})`)
        .attr("text-anchor", "end").attr("fill", muted).style("font-size", "10px").text(R.label(b));
    }
  }

  // Points, one size; shape and colour give the family.
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
  nodes.append("path").attr("d", (p) => d3.symbol(p.fam.symbol, 72)())
    .attr("fill", (p) => color(p.fam)).attr("stroke", surface).attr("stroke-width", 1.5);
  const show = (event, p) => {
    fillTip(tip, p.tip);
    const r = event.currentTarget.getBoundingClientRect();
    placeTip(tip, r.x + r.width / 2, r.y);
    d3.select(event.currentTarget).select("path").attr("stroke", css("--text-primary"));
  };
  const hide = (event) => {
    tip.hidden = true;
    d3.select(event.currentTarget).select("path").attr("stroke", surface);
  };
  nodes.on("pointerenter", show).on("pointerleave", hide).on("focus", show).on("blur", hide);

  // Labels without overlap, isolated points first. A label that does not fit
  // is dropped; the point keeps its tooltip and its table row. With labelOnce,
  // a device measured many times is named at one of its points only.
  const over = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
  const crowd = (p) => d3.sum(pts, (q) => Math.hypot(q.px - p.px, q.py - p.py) < 40);
  const seen = new Set();
  for (const p of pts.slice().sort((a, b) => crowd(a) - crowd(b))) {
    const key = opt.labelOnce ? p.label : `${Math.round(p.px)}|${Math.round(p.py)}|${p.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const t = labels.append("text").attr("fill", css("--text-primary")).attr("stroke", surface)
      .attr("stroke-width", 3).attr("paint-order", "stroke").style("font-size", "11px").text(p.label);
    const w = t.node().getComputedTextLength(), h = 11;
    const spots = [[8, 4, "start"], [-8, 4, "end"], [8, -6, "start"], [-8, -6, "end"], [8, 14, "start"], [-8, 14, "end"], [0, -10, "middle"], [0, 20, "middle"]];
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
  return out.length > 9 ? out.filter((v) => String(v).startsWith("1")) : out;
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

const HW_COLUMNS = [
  {key: "name", label: "Device"},
  {key: "vendor", label: "Vendor"},
  {key: "family", label: "Family", get: (d) => d.fam.label},
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

function renderDeviceTable() {
  drawTable(document.getElementById("hw-table"), db.devices, HW_COLUMNS, sorts.hw, renderDeviceTable);
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
