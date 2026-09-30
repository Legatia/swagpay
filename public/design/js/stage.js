import { TEE } from "./mockups.js";

const NS = "http://www.w3.org/2000/svg";

export function el(tag, attrs = {}, children = []) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, String(v));
  for (const child of children) node.append(child);
  return node;
}

export function svgPoint(svg, clientX, clientY) {
  const m = svg.getScreenCTM();
  if (!m) return { x: 0, y: 0 };
  const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
  return { x: p.x, y: p.y };
}

// Shared paint: a soft shadow under the product, and side shading so a garment reads as cloth.
function defs(ctx) {
  const unit = Math.max(ctx.mockup.viewBox[2], ctx.mockup.viewBox[3]);
  return el("defs", {}, [
    el("filter", { id: "lift", x: "-10%", y: "-10%", width: "120%", height: "130%" }, [
      el("feDropShadow", { dx: 0, dy: unit * 0.012, stdDeviation: unit * 0.016, "flood-color": "#171a38", "flood-opacity": 0.16 }),
    ]),
    el("linearGradient", { id: "cloth", x1: 0, y1: 0, x2: 1, y2: 0 }, [
      el("stop", { offset: "0", "stop-color": "#000", "stop-opacity": 0.2 }),
      el("stop", { offset: "0.22", "stop-color": "#000", "stop-opacity": 0.04 }),
      el("stop", { offset: "0.5", "stop-color": "#fff", "stop-opacity": 0.06 }),
      el("stop", { offset: "0.78", "stop-color": "#000", "stop-opacity": 0.04 }),
      el("stop", { offset: "1", "stop-color": "#000", "stop-opacity": 0.2 }),
    ]),
    el("clipPath", { id: "tee-clip" }, [el("path", { d: TEE.body })]),
  ]);
}

function decorate(svg, ctx) {
  const { kind } = ctx.mockup;
  const { widthMm: w, heightMm: h } = ctx.area;
  svg.append(defs(ctx));
  if (kind === "tee") {
    svg.append(el("path", { d: TEE.body, fill: ctx.colourHex, filter: "url(#lift)" }));
    svg.append(el("rect", { x: 0, y: 0, width: 560, height: 720, fill: "url(#cloth)", "clip-path": "url(#tee-clip)", class: "shade" }));
    if (TEE.collar[ctx.side]) svg.append(el("path", { d: TEE.collar[ctx.side], class: "collar" }));
    for (const d of TEE.seams) svg.append(el("path", { d, class: "seam" }));
    svg.append(el("path", { d: TEE.rib[ctx.side], class: "seam" }));
    svg.append(el("path", { d: TEE.body, class: "garment-edge" }));
    svg.append(el("path", { d: TEE.neck[ctx.side], class: "garment-edge" }));
  } else if (kind === "banner") {
    svg.append(el("rect", { x: 0, y: 0, width: w, height: h, class: "frame", filter: "url(#lift)" }));
    const r = Math.max(8, w * 0.006);
    for (const [x, y] of [[r * 2, r * 2], [w - r * 2, r * 2], [r * 2, h - r * 2], [w - r * 2, h - r * 2]]) svg.append(el("circle", { cx: x, cy: y, r, class: "frame" }));
  } else if (kind === "rollup") {
    svg.append(el("rect", { x: 0, y: 0, width: w, height: h, class: "frame", filter: "url(#lift)" }));
    svg.append(el("rect", { x: -w * 0.04, y: h, width: w * 1.08, height: h * 0.04, rx: h * 0.01, class: "frame" }));
  } else if (kind === "flag") {
    svg.append(el("line", { x1: -w * 0.04, y1: -h * 0.05, x2: -w * 0.04, y2: h * 1.05, stroke: "#171a38", "stroke-width": 3, "vector-effect": "non-scaling-stroke" }));
    svg.append(el("rect", { x: 0, y: 0, width: w, height: h, class: "frame", filter: "url(#lift)" }));
  }
}

function layerNode(l, assets) {
  const cx = l.xMm + l.widthMm / 2;
  const cy = l.yMm + l.heightMm / 2;
  const transform = `rotate(${l.rotationDeg} ${cx} ${cy})`;
  if (l.type === "image") {
    return el("image", { href: assets[l.file]?.dataUrl, x: l.xMm, y: l.yMm, width: l.widthMm, height: l.heightMm, preserveAspectRatio: "none", transform, class: "layer", "data-layer": l.id });
  }
  const anchor = { left: "start", center: "middle", right: "end" }[l.align] ?? "middle";
  const x = l.align === "left" ? l.xMm : l.align === "right" ? l.xMm + l.widthMm : cx;
  const node = el("text", { x, y: l.yMm + l.sizeMm, "font-family": l.font, "font-weight": l.weight, "font-size": l.sizeMm, fill: l.colour, "text-anchor": anchor, transform, class: "layer", "data-layer": l.id });
  node.textContent = l.text;
  return node;
}

// Handles are drawn small but each sits on a larger invisible hit area, so they stay easy to grab
// with a finger.
function selectionNode(l, unit) {
  const cx = l.xMm + l.widthMm / 2;
  const cy = l.yMm + l.heightMm / 2;
  const r = unit * 0.009;
  const hit = unit * 0.026;
  const stem = unit * 0.045;
  const rx = l.xMm + l.widthMm;
  const ry = l.yMm + l.heightMm;
  return el("g", { class: "selection", transform: `rotate(${l.rotationDeg} ${cx} ${cy})` }, [
    el("rect", { x: l.xMm, y: l.yMm, width: l.widthMm, height: l.heightMm }),
    el("line", { x1: cx, y1: l.yMm, x2: cx, y2: l.yMm - stem, class: "stem" }),
    el("circle", { cx, cy: l.yMm - stem, r: hit, class: "hit", "data-handle": "rotate" }),
    el("circle", { cx, cy: l.yMm - stem, r, class: "knob", "data-handle": "rotate" }),
    el("circle", { cx: rx, cy: ry, r: hit, class: "hit", "data-handle": "resize" }),
    el("rect", { x: rx - r, y: ry - r, width: r * 2, height: r * 2, rx: r * 0.3, class: "grip", "data-handle": "resize" }),
  ]);
}

// Guides are brand blue on light products and a light blue on dark garments, so they always read.
function isDark(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 110;
}

// Crop marks at the print area's corners, like a printer's proof, and its size underneath.
function printAreaMarks(w, h, unit) {
  const gap = unit * 0.008;
  const len = unit * 0.03;
  const marks = [];
  for (const [x, y, sx, sy] of [[0, 0, -1, -1], [w, 0, 1, -1], [0, h, -1, 1], [w, h, 1, 1]]) {
    marks.push(`M${x + sx * gap} ${y}h${sx * len}M${x} ${y + sy * gap}v${sy * len}`);
  }
  const label = el("text", { x: w / 2, y: h + unit * 0.045, "text-anchor": "middle", "font-size": unit * 0.02, class: "area-label" });
  label.textContent = `${Math.round(w) / 10} × ${Math.round(h) / 10} cm print area`;
  return [el("path", { d: marks.join(""), class: "crop" }), label];
}

export function renderStage(svg, ctx) {
  svg.replaceChildren();
  const [vx, vy, vw, vh] = ctx.mockup.viewBox;
  svg.setAttribute("viewBox", `${vx} ${vy} ${vw} ${vh}`);
  decorate(svg, ctx);
  const { widthMm: w, heightMm: h } = ctx.area;
  const safe = Math.min(w, h) * 0.04;
  const unit = Math.max(vw, vh);
  svg.append(el("defs", {}, [el("clipPath", { id: "print-clip" }, [el("rect", { x: 0, y: 0, width: w, height: h })])]));
  const onDark = ctx.mockup.kind === "tee" && isDark(ctx.colourHex);
  const areaGroup = el("g", { transform: `translate(${ctx.mockup.origin.x} ${ctx.mockup.origin.y})`, class: onDark ? "on-dark" : null });
  if (ctx.cutPathD) areaGroup.append(el("path", { d: ctx.cutPathD, class: "cut-preview", transform: `translate(${-ctx.borderMm} ${-ctx.borderMm})` }));
  areaGroup.append(el("rect", { x: 0, y: 0, width: w, height: h, class: "print-area" }));
  // The safe margin only matters while placing something, so it shows while a layer is selected.
  if (ctx.selectedId) areaGroup.append(el("rect", { x: safe, y: safe, width: w - 2 * safe, height: h - 2 * safe, class: "safe-area" }));
  areaGroup.append(...printAreaMarks(w, h, unit));
  const layerGroup = el("g", { "clip-path": "url(#print-clip)" });
  for (const layer of ctx.layers) layerGroup.append(layerNode(layer, ctx.assets));
  areaGroup.append(layerGroup);
  const selected = ctx.layers.find((l) => l.id === ctx.selectedId);
  if (selected) areaGroup.append(selectionNode(selected, unit));
  svg.append(areaGroup);
}

export function measureText(svg) {
  const widths = {};
  for (const node of svg.querySelectorAll("text[data-layer]")) {
    try {
      widths[node.dataset.layer] = node.getComputedTextLength();
    } catch {
      /* not rendered yet */
    }
  }
  return widths;
}
