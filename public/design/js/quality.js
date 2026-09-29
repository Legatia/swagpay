import { cm } from "./products.js";

// Resolution of an image layer at its printed size. Vector artwork and text always pass.
export function effectiveDpi(pixelWidth, widthMm) {
  return widthMm > 0 ? pixelWidth / (widthMm / 25.4) : Infinity;
}

export function maxWidthMm(pixelWidth, dpi) {
  return (pixelWidth / dpi) * 25.4;
}

export function layerQuality(layer, asset, rule) {
  if (layer.type !== "image" || !asset || asset.vector) return { status: "ok", dpi: null, maxWidthMm: null };
  const dpi = effectiveDpi(asset.pixelWidth, layer.widthMm);
  const status = dpi < rule.block ? "block" : dpi < rule.warn ? "warn" : "ok";
  return { status, dpi: Math.round(dpi), maxWidthMm: Math.floor(maxWidthMm(asset.pixelWidth, rule.warn)) };
}

export function qualityMessage(q, name) {
  if (!q || q.status === "ok") return null;
  if (q.status === "warn") return `${name} may print slightly soft at this size. For a sharp print, keep it under ${cm(q.maxWidthMm)} wide.`;
  return `${name} is too low-resolution for this size (${q.dpi} dpi). Make it smaller than ${cm(q.maxWidthMm)} wide, or upload a larger file.`;
}
