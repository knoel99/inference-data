/* Hardware specs tab. Hertzsprung-Russell style planes of the specs in
   hardware.csv: each view pairs two stated quantities and draws diagonals of a
   constant ratio. Ratios are arithmetic on the stated specs, never a
   measurement. Uses helpers from app.js (css, el, fmt, shortName, truncate). */

"use strict";

const HW_FIELDS = {
  memory_gb: {label: "Memory (GB)", short: "Memory", unit: "GB"},
  bandwidth_gb_s: {label: "Memory bandwidth (GB/s)", short: "Bandwidth", unit: "GB/s"},
  dense_bf16_fp16_tflops: {label: "Dense BF16/FP16 TFLOPS", short: "Dense 16-bit", unit: "TFLOPS"},
  fp4_tflops: {label: "FP4 TFLOPS as stated (often the sparse figure)", short: "FP4", unit: "TFLOPS"},
  tdp_w: {label: "Power as stated (W)", short: "Power", unit: "W"},
  launch_price_usd: {label: "Launch price (USD)", short: "Launch price", unit: "USD", money: true},
  market_price_usd: {label: "Market price (USD)", short: "Market price", unit: "USD", money: true},
  sweep_ms: {label: "Memory sweep time: memory ÷ bandwidth (ms)", short: "Sweep", unit: "ms", ratio: true},
  flop_per_byte: {label: "Dense FLOP per byte of bandwidth", short: "FLOP/byte", unit: "", ratio: true},
  usd_per_gb: {label: "Launch price per GB (USD/GB)", short: "USD/GB", unit: "USD/GB", ratio: true},
  usd_per_gbs: {label: "Launch price per GB/s (USD)", short: "USD per GB/s", unit: "USD", ratio: true},
  gbs_per_w: {label: "Bandwidth per watt (GB/s/W)", short: "GB/s per W", unit: "GB/s/W", ratio: true},
  gflops_per_w: {label: "Dense GFLOPS per watt", short: "GFLOPS/W", unit: "GFLOPS/W", ratio: true},
};

const HW_VIEWS = {
  memory: {
    x: "bandwidth_gb_s", y: "memory_gb",
    title: "Memory HR: capacity against bandwidth",
    sub: "Each diagonal is a constant time to read the whole memory once, t = memory ÷ bandwidth. Cards do not form a cloud: they sit on rays set by the memory chip size and its per-pin rate. With the memory full of weights and KV cache read at every decode step, 1000 ÷ t (ms) caps tokens per second per request.",
    diagonals: [
      [17.9, "17.9 ms · GDDR7 2 GB at 28 Gb/s"],
      [25, "25 ms · GDDR6 2 GB at 20 Gb/s"],
      [35.7, "35.7 ms · GDDR7 2 GB clamshell"],
      [100, "100 ms"],
      [469, "469 ms · 128 GB at 273 GB/s"],
    ].map(([t, label]) => ({k: t / 1000, label})),
  },
  compute: {
    x: "bandwidth_gb_s", y: "dense_bf16_fp16_tflops",
    title: "Compute HR: dense TFLOPS against bandwidth",
    sub: "Diagonals are constant arithmetic intensity, in FLOP per byte read. Small-batch decode needs about 2 FLOP per weight byte per request, far below every device here, which is why decode is bound by memory bandwidth. Compute matters for prefill.",
    diagonals: [64, 128, 256, 512].map((i) => ({k: i / 1000, label: `${i} FLOP/byte`})),
  },
  price: {
    x: "launch_price_usd", y: "memory_gb",
    title: "Price and memory",
    sub: "Launch price against memory. Diagonals are a constant price per GB. Prices of complete systems (Mac Studio, DGX Spark, laptops) include CPU, storage, and chassis, so they are not comparable with a bare card.",
    diagonals: [10, 30, 100, 300].map((k) => ({k: 1 / k, label: `$${k} per GB`})),
  },
  power: {
    x: "tdp_w", y: "bandwidth_gb_s",
    title: "Power efficiency: bandwidth against power",
    sub: "Diagonals are GB/s per watt, the energy cost of streaming weights during decode. Power is the figure each source states: board power for a card, system power for a DGX Spark or DGX Station.",
    diagonals: [1, 2, 4, 8].map((k) => ({k, label: `${k} GB/s per W`})),
  },
  free: {title: "Free axes", sub: "Pick any two stated specs or ratios. Color and size add two more."},
};

const VENDOR_SHAPE = {NVIDIA: d3.symbolCircle, AMD: d3.symbolDiamond, Apple: d3.symbolSquare};

const hwState = {
  view: "memory", xs: "log", ys: "log", color: "vendor", size: "memory_gb",
  fx: "bandwidth_gb_s", fy: "flop_per_byte", vendors: null,
};
const hwSort = {key: "bandwidth_gb_s", dir: -1};

const Hardware = {
  read(q) {
    if (HW_VIEWS[q.get("hv")]) hwState.view = q.get("hv");
    if (q.get("hxs") === "lin") hwState.xs = "lin";
    if (q.get("hys") === "lin") hwState.ys = "lin";
    if (HW_FIELDS[q.get("hfx")]) hwState.fx = q.get("hfx");
    if (HW_FIELDS[q.get("hfy")]) hwState.fy = q.get("hfy");
  },
  write(q) {
    if (hwState.view !== "memory") q.set("hv", hwState.view);
    if (hwState.xs !== "log") q.set("hxs", hwState.xs);
    if (hwState.ys !== "log") q.set("hys", hwState.ys);
    if (hwState.view === "free") { q.set("hfx", hwState.fx); q.set("hfy", hwState.fy); }
  },
  init(db) {
    const devices = [...db.hardware.values()].map((h) => withRatios(h, db));
    this.devices = devices;
    const vendors = d3.groupSort(devices, (v) => -v.length, (d) => d.vendor);
    this.vendors = vendors;
    hwState.vendors = new Set(vendors);

    chipGroup("hw-view", (b) => b.dataset.v === hwState.view, (b) => { hwState.view = b.dataset.v; });
    segGroup("hw-xs", "xs");
    segGroup("hw-ys", "ys");
    const vbox = document.getElementById("hw-vendors");
    vbox.replaceChildren(...vendors.map((v) => {
      const b = el("button", "chip", v);
      b.type = "button";
      b.dataset.v = v;
      b.setAttribute("aria-pressed", "true");
      b.addEventListener("click", () => {
        hwState.vendors.has(v) ? hwState.vendors.delete(v) : hwState.vendors.add(v);
        b.setAttribute("aria-pressed", String(hwState.vendors.has(v)));
        render();
      });
      return b;
    }));
    for (const [id, key] of [["hw-color", "color"], ["hw-size", "size"]]) {
      const s = document.getElementById(id);
      s.value = hwState[key];
      s.addEventListener("change", () => { hwState[key] = s.value; render(); });
    }
    const options = Object.entries(HW_FIELDS).map(([k, f]) => [k, f.label]);
    for (const [id, key] of [["hw-fx", "fx"], ["hw-fy", "fy"]]) {
      const s = document.getElementById(id);
      fill(s, options, hwState[key]);
      s.addEventListener("change", () => { hwState[key] = s.value; render(); });
    }
  },
  render(db) {
    if (!this.devices) this.init(db);
    syncPressed();
    const view = HW_VIEWS[hwState.view];
    const xk = hwState.view === "free" ? hwState.fx : view.x;
    const yk = hwState.view === "free" ? hwState.fy : view.y;
    document.getElementById("hw-free").hidden = hwState.view !== "free";
    document.getElementById("hw-title").textContent = view.title;
    document.getElementById("hw-sub").textContent = view.sub;
    const shown = this.devices.filter((d) => hwState.vendors.has(d.vendor));
    const data = shown.filter((d) => d[xk] != null && d[yk] != null && (hwState.xs === "lin" || d[xk] > 0) && (hwState.ys === "lin" || d[yk] > 0));
    const missing = shown.filter((d) => !data.includes(d)).map((d) => d.short);
    document.getElementById("hw-foot").textContent = missing.length
      ? `Not drawn, because hardware.csv states no ${HW_FIELDS[xk].short} or no ${HW_FIELDS[yk].short} value for them: ${missing.join(", ")}.`
      : "";
    drawPlane(document.getElementById("chart-hw"), data, xk, yk, view.diagonals || [], this.vendors);
    drawLegend(data, this.vendors);
    drawReadout(data, xk, yk);
    drawDeviceTable(this.devices, db);
  },
};

function withRatios(h, db) {
  const d = {...h, short: shortName(h.name)};
  const div = (a, b, k = 1) => (a != null && b ? (a / b) * k : null);
  d.sweep_ms = div(h.memory_gb, h.bandwidth_gb_s, 1000);
  d.flop_per_byte = div(h.dense_bf16_fp16_tflops, h.bandwidth_gb_s, 1000);
  d.usd_per_gb = div(h.launch_price_usd, h.memory_gb);
  d.usd_per_gbs = div(h.launch_price_usd, h.bandwidth_gb_s);
  d.gbs_per_w = div(h.bandwidth_gb_s, h.tdp_w);
  d.gflops_per_w = div(h.dense_bf16_fp16_tflops, h.tdp_w, 1000);
  const src = db.sources.get(h.source_id);
  d.sourceTitle = src ? src.title : h.source_id;
  d.sourceUrl = src ? src.url : null;
  return d;
}

function chipGroup(id, isOn, set) {
  for (const b of document.querySelectorAll(`#${id} button`)) {
    b.setAttribute("aria-pressed", String(isOn(b)));
    b.addEventListener("click", () => { set(b); render(); });
  }
}

function segGroup(id, key) {
  for (const b of document.querySelectorAll(`#${id} button`)) {
    b.addEventListener("click", () => { hwState[key] = b.dataset.s; render(); });
  }
}

function syncPressed() {
  for (const b of document.querySelectorAll("#hw-view button")) b.setAttribute("aria-pressed", String(b.dataset.v === hwState.view));
  for (const [id, key] of [["hw-xs", "xs"], ["hw-ys", "ys"]]) {
    for (const b of document.querySelectorAll(`#${id} button`)) b.setAttribute("aria-pressed", String(b.dataset.s === hwState[key]));
  }
}

/* ---------- the plane ---------- */

function drawPlane(box, data, xk, yk, diagonals, vendors) {
  if (!data.length) return empty(box, "No device has both values for the current selection.");
  const width = box.clientWidth || 900;
  const narrow = width < 560;
  const height = Math.round(Math.min(560, Math.max(340, width * 0.6)));
  const m = {top: 16, right: narrow ? 12 : 24, bottom: 52, left: narrow ? 52 : 68};
  const iw = width - m.left - m.right, ih = height - m.top - m.bottom;
  const logx = hwState.xs === "log", logy = hwState.ys === "log";
  const x = (logx ? d3.scaleLog() : d3.scaleLinear()).domain(pad(data.map((d) => d[xk]), logx)).range([0, iw]);
  const y = (logy ? d3.scaleLog() : d3.scaleLinear()).domain(pad(data.map((d) => d[yk]), logy)).range([ih, 0]);

  const svg = d3.create("svg").attr("width", width).attr("height", height).attr("viewBox", [0, 0, width, height])
    .attr("role", "img").attr("aria-label", `${HW_FIELDS[yk].label} against ${HW_FIELDS[xk].label}`)
    .style("font", "12px system-ui, -apple-system, 'Segoe UI', sans-serif");
  const g = svg.append("g").attr("transform", `translate(${m.left},${m.top})`);
  const clipId = `hw-clip-${xk}-${yk}`;
  svg.append("clipPath").attr("id", clipId).append("rect").attr("width", iw).attr("height", ih);

  const xt = ticks(x, logx, narrow ? 5 : 8), yt = ticks(y, logy, 7);
  const grid = css("--grid"), axis = css("--axis"), muted = css("--text-muted"), ink2 = css("--text-secondary");
  g.append("g").selectAll("line").data(xt).join("line")
    .attr("x1", x).attr("x2", x).attr("y1", 0).attr("y2", ih).attr("stroke", grid);
  g.append("g").selectAll("line").data(yt).join("line")
    .attr("y1", y).attr("y2", y).attr("x1", 0).attr("x2", iw).attr("stroke", grid);
  g.append("line").attr("x1", 0).attr("x2", iw).attr("y1", ih).attr("y2", ih).attr("stroke", axis);
  g.append("line").attr("x1", 0).attr("x2", 0).attr("y1", 0).attr("y2", ih).attr("stroke", axis);
  const fx = tickFormat(xk), fy = tickFormat(yk);
  g.append("g").selectAll("text").data(xt).join("text")
    .attr("x", x).attr("y", ih + 18).attr("text-anchor", "middle").attr("fill", ink2)
    .style("font-variant-numeric", "tabular-nums").text(fx);
  g.append("g").selectAll("text").data(yt).join("text")
    .attr("x", -8).attr("y", (d) => y(d) + 4).attr("text-anchor", "end").attr("fill", ink2)
    .style("font-variant-numeric", "tabular-nums").text(fy);
  g.append("text").attr("x", iw).attr("y", ih + 42).attr("text-anchor", "end").attr("fill", ink2)
    .text(`${HW_FIELDS[xk].label}${logx ? ", log" : ""} →`);
  g.append("text").attr("x", -m.left + 4).attr("y", -4).attr("fill", ink2).attr("dominant-baseline", "auto")
    .text(`↑ ${HW_FIELDS[yk].label}${logy ? ", log" : ""}`);

  // Diagonals y = k·x, labelled along the visible part of the line.
  const surface = css("--surface-1");
  const plot = g.append("g").attr("clip-path", `url(#${clipId})`);
  const [x0, x1] = x.domain();
  diagonals.forEach((dg, i) => {
    const pts = d3.range(81).map((j) => {
      const xv = logx ? x0 * (x1 / x0) ** (j / 80) : x0 + ((x1 - x0) * j) / 80;
      return [x(xv), y(xv * dg.k)];
    });
    plot.append("path").attr("d", d3.line()(pts)).attr("fill", "none").attr("stroke", axis).attr("stroke-width", 1);
    lineLabel(g, pts, iw, ih, narrow ? dg.label.split(" · ")[0] : dg.label, i % 2 ? 0.86 : 0.14, muted, surface);
  });

  // Points: shape is the vendor, so identity never rests on colour alone.
  const color = colorFor(data, vendors);
  const size = sizeFor(data, narrow);
  const sorted = data.slice().sort((a, b) => size(b) - size(a));
  const tip = document.getElementById("tip");
  const pts = g.append("g").selectAll("g").data(sorted).join("g")
    .attr("transform", (d) => `translate(${x(d[xk])},${y(d[yk])})`)
    .attr("tabindex", 0).attr("role", "img").attr("aria-label", (d) => `${d.name}: ${HW_FIELDS[xk].short} ${fmt(d[xk])}, ${HW_FIELDS[yk].short} ${fmt(d[yk])}`)
    .style("cursor", "default").style("outline", "none");
  pts.append("circle").attr("r", (d) => Math.max(12, size(d) + 4)).attr("fill", "transparent");
  pts.append("path")
    .attr("d", (d) => d3.symbol(VENDOR_SHAPE[d.vendor] || d3.symbolTriangle, Math.PI * size(d) ** 2)())
    .attr("fill", color).attr("fill-opacity", 0.9).attr("stroke", surface).attr("stroke-width", 2);
  const show = (event, d) => {
    showTip(tip, d, [xk, yk, hwState.size, hwState.color].filter((k) => HW_FIELDS[k]));
    const r = event.currentTarget.getBoundingClientRect();
    placeTip(tip, r.x + r.width / 2, r.y);
    d3.select(event.currentTarget).select("path").attr("stroke", css("--text-primary"));
  };
  const hide = (event) => {
    tip.hidden = true;
    d3.select(event.currentTarget).select("path").attr("stroke", surface);
  };
  pts.on("pointerenter", show).on("pointerleave", hide).on("focus", show).on("blur", hide);

  // Labels: devices on the same pixel share one label; a label that cannot be
  // placed without overlap is dropped and stays reachable by hover and the table.
  const groups = d3.groups(sorted, (d) => `${Math.round(x(d[xk]) / 4)}|${Math.round(y(d[yk]) / 4)}`)
    .map(([, v]) => ({x: x(v[0][xk]), y: y(v[0][yk]), r: size(v[0]), text: v.map((d) => d.short).join(" · ")}));
  placeLabels(g, groups, iw, ih, sorted.map((d) => ({x: x(d[xk]), y: y(d[yk]), r: size(d)})), ink2, surface);

  box.replaceChildren(svg.node());
}

function pad(values, log) {
  const lo = d3.min(values), hi = d3.max(values);
  if (log) return lo === hi ? [lo / 2, hi * 2] : [lo / 1.5, hi * 1.5];
  const span = hi - lo || Math.abs(hi) || 1;
  return [Math.max(0, lo - span * 0.1), hi + span * 0.1];
}

function ticks(scale, log, count) {
  if (!log) return scale.ticks(count);
  const [lo, hi] = scale.domain();
  for (const mantissas of [d3.range(1, 10), [1, 2, 5], [1, 3], [1]]) {
    const t = d3.range(Math.floor(Math.log10(lo)), Math.ceil(Math.log10(hi)) + 1)
      .flatMap((p) => mantissas.map((mm) => mm * 10 ** p)).filter((v) => v >= lo && v <= hi);
    if (t.length <= count) return t.length >= 2 ? t : scale.ticks(count);
  }
  return d3.range(Math.ceil(Math.log10(lo)), Math.floor(Math.log10(hi)) + 1).filter((_, i) => i % 2 === 0).map((p) => 10 ** p);
}

function tickFormat(key) {
  const s = d3.format("~s");
  return HW_FIELDS[key].money ? (v) => `$${s(v)}` : (v) => (v < 1 ? d3.format("~r")(v) : s(v));
}

function lineLabel(g, pts, iw, ih, text, frac, fill, halo) {
  const inside = pts.filter(([px, py]) => px >= 0 && px <= iw && py >= 0 && py <= ih);
  if (inside.length < 2) return;
  const lens = [0];
  for (let i = 1; i < inside.length; i++) lens.push(lens[i - 1] + Math.hypot(inside[i][0] - inside[i - 1][0], inside[i][1] - inside[i - 1][1]));
  const total = lens[lens.length - 1];
  if (total < text.length * 6) return;
  const target = total * frac;
  const i = Math.max(1, Math.min(inside.length - 1, lens.findIndex((v) => v >= target)));
  const [a, b] = [inside[i - 1], inside[i]];
  const t = (target - lens[i - 1]) / (lens[i] - lens[i - 1] || 1);
  const angle = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  g.append("text").attr("transform", `translate(${a[0] + (b[0] - a[0]) * t},${a[1] + (b[1] - a[1]) * t}) rotate(${angle})`)
    .attr("y", -4).attr("text-anchor", "middle").attr("fill", fill).attr("stroke", halo).attr("stroke-width", 3)
    .attr("paint-order", "stroke").style("font-size", "10.5px").text(text);
}

function placeLabels(g, items, iw, ih, points, fill, halo) {
  const placed = [];
  const obstacles = points.map((p) => ({x0: p.x - p.r, x1: p.x + p.r, y0: p.y - p.r, y1: p.y + p.r}));
  const hit = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
  const layer = g.append("g").attr("pointer-events", "none");
  for (const it of items.sort((a, b) => b.r - a.r)) {
    const w = it.text.length * 6.4, h = 13, r = it.r + 4;
    const options = [
      [it.x + r, it.y + 4, "start"], [it.x - r, it.y + 4, "end"],
      [it.x, it.y - r - 3, "middle"], [it.x, it.y + r + 12, "middle"],
      [it.x + r * 0.7, it.y - r * 0.7 - 2, "start"], [it.x + r * 0.7, it.y + r * 0.7 + 11, "start"],
      [it.x - r * 0.7, it.y - r * 0.7 - 2, "end"], [it.x - r * 0.7, it.y + r * 0.7 + 11, "end"],
    ];
    for (const [tx, ty, anchor] of options) {
      const x0 = anchor === "start" ? tx : anchor === "end" ? tx - w : tx - w / 2;
      const bbox = {x0, x1: x0 + w, y0: ty - h + 3, y1: ty + 3};
      if (bbox.x0 < 0 || bbox.x1 > iw || bbox.y0 < 0 || bbox.y1 > ih) continue;
      if (placed.some((p) => hit(p, bbox))) continue;
      if (obstacles.some((o) => hit(o, bbox) && !(Math.abs(o.x0 + o.x1 - 2 * it.x) < 1 && Math.abs(o.y0 + o.y1 - 2 * it.y) < 1))) continue;
      placed.push(bbox);
      layer.append("text").attr("x", tx).attr("y", ty).attr("text-anchor", anchor).attr("fill", fill)
        .attr("stroke", halo).attr("stroke-width", 3).attr("paint-order", "stroke").text(it.text);
      break;
    }
  }
}

/* ---------- colour, size, legend ---------- */

function colorFor(data, vendors) {
  const missing = css("--grid");
  if (hwState.color === "vendor") {
    const range = palette();
    return (d) => range[vendors.indexOf(d.vendor)] ?? css("--series-other");
  }
  const vals = data.map((d) => d[hwState.color]).filter((v) => v > 0);
  if (!vals.length) return () => missing;
  const [lo, hi] = css(hwState.color === "tdp_w" ? "--seq-warm" : "--seq-blue").split(",").map((s) => s.trim());
  const t = d3.scaleLog().domain(d3.extent(vals)).range([0, 1]).clamp(true);
  const ramp = d3.interpolateLab(lo, hi);
  return (d) => (d[hwState.color] > 0 ? ramp(vals.length > 1 ? t(d[hwState.color]) : 0.7) : missing);
}

function sizeFor(data, narrow) {
  if (hwState.size === "none") return () => 6;
  const max = d3.max(data, (d) => d[hwState.size]) || 1;
  const r = d3.scaleSqrt().domain([0, max]).range([0, narrow ? 14 : 20]);
  return (d) => (d[hwState.size] > 0 ? Math.max(5, r(d[hwState.size])) : 4.5);
}

function drawLegend(data, vendors) {
  const box = document.getElementById("hw-legend");
  const items = [];
  const present = vendors.filter((v) => data.some((d) => d.vendor === v));
  const range = palette();
  for (const v of present) {
    const k = el("span", "k");
    const svg = d3.create("svg").attr("width", 14).attr("height", 14).attr("viewBox", "-7 -7 14 14");
    svg.append("path").attr("d", d3.symbol(VENDOR_SHAPE[v] || d3.symbolTriangle, 70)())
      .attr("fill", hwState.color === "vendor" ? range[vendors.indexOf(v)] : css("--text-secondary"));
    k.append(svg.node(), document.createTextNode(v));
    items.push(k);
  }
  if (hwState.color !== "vendor") {
    const vals = data.map((d) => d[hwState.color]).filter((v) => v > 0);
    const k = el("span", "k");
    const [lo, hi] = css(hwState.color === "tdp_w" ? "--seq-warm" : "--seq-blue").split(",").map((s) => s.trim());
    const bar = el("span", "ramp");
    bar.style.background = `linear-gradient(90deg, ${lo}, ${hi})`;
    const f = HW_FIELDS[hwState.color];
    const ends = vals.length ? `${fmtValue(d3.min(vals), f)} to ${fmtValue(d3.max(vals), f)}` : "not stated";
    k.append(document.createTextNode(`Color: ${f.short.toLowerCase()}, log`), bar, document.createTextNode(`${ends}; gray = not stated`));
    items.push(k);
  }
  const s = HW_FIELDS[hwState.size];
  items.push(el("span", "k muted", s ? `Size: ${s.short.toLowerCase()} (small dot = not stated)` : "Size: fixed"));
  box.replaceChildren(...items);
}

function fmtValue(v, f) {
  if (v == null) return "not stated";
  const n = v.toLocaleString("en", {maximumFractionDigits: v < 10 ? 2 : v < 100 ? 1 : 0});
  return f.money ? `$${n}` : f.unit ? `${n} ${f.unit}` : n;
}

/* ---------- readout: facts computed from the drawn rows ---------- */

function drawReadout(data, xk, yk) {
  const box = document.getElementById("hw-read");
  const paras = [];
  const by = (key, desc = true) => data.filter((d) => d[key] != null).sort((a, b) => (desc ? b[key] - a[key] : a[key] - b[key]));
  const list = (rows, key, n = 4) => rows.slice(0, n).map((d) => `${d.short} ${fmtValue(d[key], HW_FIELDS[key])}`).join(", ");
  if (hwState.view === "memory") {
    const rays = d3.groups(by("sweep_ms", false), (d) => Math.round(d.sweep_ms * 2) / 2)
      .filter(([, v]) => v.length > 1)
      .map(([t, v]) => `${t} ms: ${v.map((d) => d.short).join(", ")}`);
    if (rays.length) paras.push(["Devices sharing a ray.", rays.join(". ") + "."]);
    const s = by("sweep_ms", false);
    if (s.length) paras.push(["Full-memory ceiling.", `Reading all memory once takes ${fmtValue(s[0].sweep_ms, HW_FIELDS.sweep_ms)} on ${s[0].short} and ${fmtValue(s[s.length - 1].sweep_ms, HW_FIELDS.sweep_ms)} on ${s[s.length - 1].short}, so a request on a full device cannot exceed about ${Math.round(1000 / s[0].sweep_ms)} and ${Math.round(1000 / s[s.length - 1].sweep_ms)} tok/s respectively, before any efficiency loss. This is arithmetic on the specs, not a measurement.`]);
  } else if (hwState.view === "compute") {
    const r = by("flop_per_byte");
    if (r.length) paras.push(["FLOP per byte, highest first.", list(r, "flop_per_byte", 8) + "."]);
    paras.push(["Format caveat.", "The column holds dense BF16 or FP16 tensor throughput as each source states it; the device notes say which. Compare within a vendor before across vendors."]);
  } else if (hwState.view === "price") {
    const r = by("usd_per_gb", false);
    if (r.length) paras.push(["Launch price per GB, lowest first.", list(r, "usd_per_gb", 8) + "."]);
    const priced = this_devices().filter((d) => d.launch_price_usd != null).length;
    paras.push(["Coverage.", `${priced} of ${this_devices().length} devices have a sourced launch price. Prices seen only in private notes are not stored, so most cards are missing here.`]);
  } else if (hwState.view === "power") {
    const r = by("gbs_per_w");
    if (r.length) paras.push(["GB/s per watt, highest first.", list(r, "gbs_per_w", 8) + "."]);
  } else {
    const r = data.map((d) => [Math.log(d[xk]), Math.log(d[yk])]).filter(([a, b]) => isFinite(a) && isFinite(b));
    if (r.length >= 3) {
      const mx = d3.mean(r, (p) => p[0]), my = d3.mean(r, (p) => p[1]);
      const sxy = d3.sum(r, (p) => (p[0] - mx) * (p[1] - my)), sxx = d3.sum(r, (p) => (p[0] - mx) ** 2), syy = d3.sum(r, (p) => (p[1] - my) ** 2);
      if (sxx > 0 && syy > 0) paras.push(["Log-log fit on the drawn devices.", `slope ${(sxy / sxx).toFixed(2)}, R² ${((sxy * sxy) / (sxx * syy)).toFixed(2)}, n = ${r.length}. A straight line in log-log betrays a construction or pricing rule; a cloud, the absence of one.`]);
    }
  }
  box.replaceChildren(...paras.map(([head, body]) => {
    const p = el("p");
    p.append(el("b", "", head + " "), document.createTextNode(body));
    return p;
  }));
}

function this_devices() {
  return Hardware.devices.filter((d) => hwState.vendors.has(d.vendor));
}

/* ---------- tooltip ---------- */

function showTip(tip, d, keys) {
  const rows = [...new Set(["memory_gb", "bandwidth_gb_s", ...keys])];
  tip.replaceChildren(el("b", "", d.name));
  for (const k of rows) {
    const r = el("div", "r");
    r.append(el("span", "", HW_FIELDS[k].short), el("span", "", fmtValue(d[k], HW_FIELDS[k])));
    tip.append(r);
  }
  tip.append(el("div", "n", `Source: ${d.sourceTitle}`));
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

/* ---------- device table ---------- */

const HW_COLUMNS = [
  {key: "name", label: "Device"},
  {key: "vendor", label: "Vendor"},
  ...["memory_gb", "bandwidth_gb_s", "dense_bf16_fp16_tflops", "fp4_tflops", "tdp_w", "launch_price_usd", "market_price_usd",
    "sweep_ms", "flop_per_byte", "usd_per_gb", "gbs_per_w"].map((key) => ({key, label: HW_FIELDS[key].short + (HW_FIELDS[key].unit && !HW_FIELDS[key].ratio ? ` (${HW_FIELDS[key].unit})` : ""), num: true})),
  {key: "sourceTitle", label: "Source"},
  {key: "notes", label: "Notes"},
];

function drawDeviceTable(devices) {
  const table = document.getElementById("hw-table");
  const data = devices.slice().sort((a, b) => {
    const x = a[hwSort.key], y = b[hwSort.key];
    if (x == null) return 1;
    if (y == null) return -1;
    return hwSort.dir * (typeof x === "number" ? x - y : String(x).localeCompare(String(y)));
  });
  const head = el("tr");
  for (const c of HW_COLUMNS) {
    const th = el("th", c.num ? "num" : "", c.label);
    th.scope = "col";
    if (hwSort.key === c.key) th.setAttribute("aria-sort", hwSort.dir > 0 ? "ascending" : "descending");
    th.addEventListener("click", () => {
      hwSort.dir = hwSort.key === c.key ? -hwSort.dir : (c.num ? -1 : 1);
      hwSort.key = c.key;
      drawDeviceTable(devices);
    });
    head.append(th);
  }
  const rows = data.map((d) => {
    const tr = el("tr");
    for (const c of HW_COLUMNS) {
      const v = d[c.key];
      const td = el("td", c.num ? "num" : "");
      if (c.key === "sourceTitle" && d.sourceUrl) {
        const a = el("a", "", truncate(v, 36));
        a.href = d.sourceUrl;
        a.rel = "noopener";
        a.title = v;
        td.append(a);
      } else if (c.key === "notes") {
        td.className = "notes";
        const details = el("details");
        details.append(el("summary", "", truncate(v ?? "", 70)), el("div", "", v ?? ""));
        td.append(details);
      } else if (c.key === "market_price_usd" && v != null) {
        td.textContent = `${fmt(v)}${d.market_price_date ? ` (${d.market_price_date})` : ""}`;
      } else {
        td.textContent = v == null ? "" : c.num ? fmt(v) : v;
      }
      tr.append(td);
    }
    return tr;
  });
  table.replaceChildren(el("thead"), el("tbody"));
  table.tHead.append(head);
  table.tBodies[0].append(...rows);
}
