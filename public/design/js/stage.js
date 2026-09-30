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

function decorate(svg, ctx) {
  const { kind } = ctx.mockup;
  const { widthMm: w, heightMm: h } = ctx.area;
  if (kind === "tee") {
    svg.append(el("path", { d: TEE.body, class: "garment", fill: ctx.colourHex }));
    svg.append(el("path", { d: TEE.neck[ctx.side], class: "garment", fill: "none" }));
  } else if (kind === "banner") {
    svg.append(el("rect", { x: 0, y: 0, width: w, height: h, class: "frame" }));
    const r = Math.max(8, w * 0.006);
    for (const [x, y] of [[r * 2, r * 2], [w - r * 2, r * 2], [r * 2, h - r * 2], [w - r * 2, h - r * 2]]) svg.append(el("circle", { cx: x, cy: y, r, class: "frame" }));
  } else if (kind === "rollup") {
    svg.append(el("rect", { x: 0, y: 0, width: w, height: h, class: "frame" }));
    svg.append(el("rect", { x: -w * 0.04, y: h, width: w * 1.08, height: h * 0.04, rx: h * 0.01, class: "frame" }));
  } else if (kind === "flag") {
    svg.append(el("line", { x1: -w * 0.04, y1: -h * 0.05, x2: -w * 0.04, y2: h * 1.05, stroke: "#171a38", "stroke-width": 3, "vector-effect": "non-scaling-stroke" }));
    svg.append(el("rect", { x: 0, y: 0, width: w, height: h, class: "frame" }));
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

function selectionNode(l, handleR) {
  const cx = l.xMm + l.widthMm / 2;
  const cy = l.yMm + l.heightMm / 2;
  return el("g", { class: "selection", transform: `rotate(${l.rotationDeg} ${cx} ${cy})` }, [
    el("rect", { x: l.xMm, y: l.yMm, width: l.widthMm, height: l.heightMm }),
    el("line", { x1: cx, y1: l.yMm, x2: cx, y2: l.yMm - handleR * 3, stroke: "#d7266f", "stroke-width": 1.5, "vector-effect": "non-scaling-stroke" }),
    el("circle", { cx, cy: l.yMm - handleR * 3, r: handleR, "data-handle": "rotate" }),
    el("circle", { cx: l.xMm + l.widthMm, cy: l.yMm + l.heightMm, r: handleR, "data-handle": "resize" }),
  ]);
}

export function renderStage(svg, ctx) {
  svg.replaceChildren();
  const [vx, vy, vw, vh] = ctx.mockup.viewBox;
  svg.setAttribute("viewBox", `${vx} ${vy} ${vw} ${vh}`);
  decorate(svg, ctx);
  const { widthMm: w, heightMm: h } = ctx.area;
  const safe = Math.min(w, h) * 0.04;
  svg.append(el("defs", {}, [el("clipPath", { id: "print-clip" }, [el("rect", { x: 0, y: 0, width: w, height: h })])]));
  const areaGroup = el("g", { transform: `translate(${ctx.mockup.origin.x} ${ctx.mockup.origin.y})` });
  if (ctx.cutPathD) areaGroup.append(el("path", { d: ctx.cutPathD, class: "cut-preview", transform: `translate(${-ctx.borderMm} ${-ctx.borderMm})` }));
  areaGroup.append(el("rect", { x: 0, y: 0, width: w, height: h, class: "print-area" }));
  areaGroup.append(el("rect", { x: safe, y: safe, width: w - 2 * safe, height: h - 2 * safe, class: "safe-area" }));
  const layerGroup = el("g", { "clip-path": "url(#print-clip)" });
  for (const layer of ctx.layers) layerGroup.append(layerNode(layer, ctx.assets));
  areaGroup.append(layerGroup);
  const selected = ctx.layers.find((l) => l.id === ctx.selectedId);
  if (selected) areaGroup.append(selectionNode(selected, Math.max(vw, vh) * 0.018));
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
