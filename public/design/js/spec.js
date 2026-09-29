import { round1 } from "./geometry.js";
import { OWNER_NOTE, PRODUCTS, SIZE_KEYS, cm, dims } from "./products.js";
import { effectiveDpi } from "./quality.js";

// The design spec sent to POST /api/o/<token>/design (validated by the backend's
// src/design-spec.ts). Any change to its shape bumps SPEC_VERSION.
export const SPEC_VERSION = 1;
export const SPEC_MAX_BYTES = 64 * 1024;
export const MAX_LAYERS = 20;
export const MAX_FILES = 10;

// The backend wants every size above zero and effectiveDpi at most 100000, so tiny layers are
// floored instead of sent as 0.
const size1 = (v) => Math.max(0.1, round1(v));
const whole = (n) => Math.max(0, Math.floor(Number(n) || 0));

function specLayer(l, assets) {
  if (l.type === "image") {
    const asset = assets[l.file];
    const widthMm = size1(l.widthMm);
    const out = {
      type: "image",
      file: l.file,
      xMm: round1(l.xMm),
      yMm: round1(l.yMm),
      widthMm,
      heightMm: size1(l.heightMm),
      rotationDeg: round1(l.rotationDeg),
    };
    if (asset && !asset.vector) {
      const dpi = Math.round(effectiveDpi(asset.pixelWidth, widthMm));
      if (Number.isFinite(dpi)) out.effectiveDpi = Math.min(100000, Math.max(0, dpi));
    }
    return out;
  }
  return {
    type: "text",
    text: l.text.trim().slice(0, 200),
    font: l.font,
    weight: l.weight,
    colour: l.colour,
    sizeMm: size1(l.sizeMm),
    xMm: round1(l.xMm),
    yMm: round1(l.yMm),
    widthMm: size1(l.widthMm),
    rotationDeg: round1(l.rotationDeg),
    align: l.align,
  };
}

export function specSize(spec) {
  return new TextEncoder().encode(JSON.stringify(spec)).length;
}

export function buildSpec(state) {
  const product = PRODUCTS[state.product];
  if (!product) return { error: "Pick a product first." };
  const views = (state.areas || [])
    .map((area) => ({
      side: area.side,
      printArea: { widthMm: round1(area.widthMm), heightMm: round1(area.heightMm) },
      layers: (state.layers?.[area.side] || [])
        .filter((l) => l.type !== "text" || l.text.trim().length > 0)
        .map((l) => specLayer(l, state.assets || {})),
    }))
    .filter((v) => v.layers.length > 0);
  if (views.length === 0) return { error: "Add a logo or some text before continuing." };
  if (views.some((v) => v.layers.length > MAX_LAYERS)) return { error: `A side can have at most ${MAX_LAYERS} layers.` };

  let sizes = null;
  let quantity;
  if (state.product === "tshirt") {
    sizes = {};
    for (const key of SIZE_KEYS) {
      const n = whole(state.sizes?.[key]);
      if (n > 0) sizes[key] = n;
    }
    quantity = Object.values(sizes).reduce((a, n) => a + n, 0);
  } else {
    quantity = whole(state.quantity);
  }
  if (quantity < 1) return { error: "Enter how many you need." };
  if (quantity > 5000) return { error: "Orders go up to 5,000 pieces. For more, describe it to the agent." };

  if (state.product === "sticker" && !state.cutPathD) return { error: "The sticker's cut line is still being prepared. Try again in a moment." };

  const files = {};
  for (const v of views) for (const l of v.layers) if (l.type === "image") files[l.file] = { role: "artwork" };
  for (const v of views) {
    files[`mockup-${v.side}`] = { role: "mockup" };
    files[`print-${v.side}`] = { role: "print" };
  }
  if (state.product === "sticker") files.cutline = { role: "cutline" };
  if (Object.keys(files).length > MAX_FILES) {
    const artwork = Object.values(files).filter((f) => f.role === "artwork").length;
    return { error: `Too many images for one order. Use at most ${artwork - (Object.keys(files).length - MAX_FILES)} different logos.` };
  }

  const spec = {
    version: SPEC_VERSION,
    product: state.product,
    options: { ...(state.options || {}) },
    views,
    sizes,
    quantity,
    sticker: state.product === "sticker" ? { longestSideMm: state.sticker.longestSideMm, shape: state.sticker.shape, borderMm: product.borderMm } : null,
    estimate: state.estimate?.status === "ok" ? { currency: state.estimate.currency, low: state.estimate.low, high: state.estimate.high } : null,
    files,
  };
  if (specSize(spec) > SPEC_MAX_BYTES) return { error: "This design is too large to send. Remove a text layer or two." };
  return { spec };
}

const SYMBOL = { USD: "$", EUR: "€" };
const SIDE = { front: "Front", back: "Back" };

function describeLayers(layers) {
  return layers.map((l) => (l.type === "image" ? `logo ${dims(l.widthMm, l.heightMm)}` : `the text "${l.text}"`)).join(", ");
}

export function summarize(spec) {
  const p = PRODUCTS[spec.product];
  const parts = [];
  if (spec.product === "tshirt") {
    const colour = p.colours.find((c) => c.key === spec.options.colour)?.label.toLowerCase() ?? spec.options.colour;
    const split = Object.entries(spec.sizes).map(([k, n]) => `${k} ${n}`).join(", ");
    parts.push(`${spec.quantity} ${colour} t-shirts (${split}).`);
  } else if (spec.product === "sticker") {
    const shape = { contour: "following the logo", circle: "as a circle", "rounded-square": "as a rounded square" }[spec.sticker.shape];
    parts.push(`${spec.quantity} die-cut stickers, ${cm(spec.sticker.longestSideMm)} on the longest side, ${shape}, with a ${spec.sticker.borderMm} mm white border.`);
  } else {
    const preset = p.presets.find((x) => x.key === spec.options.size) ?? p.presets[0];
    parts.push(`${spec.quantity} × ${p.name.toLowerCase()} ${preset.label}.`);
  }
  const sides = spec.product === "tshirt" ? ["front", "back"] : ["front"];
  for (const side of sides) {
    const view = spec.views.find((v) => v.side === side);
    parts.push(`${SIDE[side]}: ${view ? describeLayers(view.layers) : "blank"}.`);
  }
  parts.push(spec.estimate ? `Estimate ${SYMBOL[spec.estimate.currency]}${spec.estimate.low}–${spec.estimate.high}.` : "The agent will quote the price.");
  if (p.needsOwner) parts.push(OWNER_NOTE);
  return parts.join(" ");
}
