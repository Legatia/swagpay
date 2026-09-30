import { printSvg, stickerSvg } from "./export.js";
import { TEE, mockupFor } from "./mockups.js";
import { PRODUCTS } from "./products.js";
import { canvasBlob, drawLayers } from "./raster.js";
import { sniffImageType } from "./upload.js";

async function mockupPng(s, view) {
  const a = s.areas.find((x) => x.side === view.side);
  const m = mockupFor(s.product, view.side, a);
  const [vx, vy, vw, vh] = m.viewBox;
  const width = 1200;
  const k = width / vw;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.round(vh * k);
  const g = canvas.getContext("2d");
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.translate(-vx * k, -vy * k);
  if (m.kind === "tee") {
    const hex = PRODUCTS.tshirt.colours.find((c) => c.key === s.options.colour)?.hex ?? "#ffffff";
    g.save();
    g.scale(k, k);
    g.fillStyle = hex;
    g.strokeStyle = "#171a38";
    g.lineWidth = 2;
    const body = new Path2D(TEE.body);
    g.fill(body);
    g.stroke(body);
    g.stroke(new Path2D(TEE.neck[view.side]));
    if (TEE.collar[view.side]) {
      g.fillStyle = "rgba(0, 0, 0, 0.3)";
      g.fill(new Path2D(TEE.collar[view.side]));
    }
    g.restore();
  } else {
    g.strokeStyle = "#171a38";
    g.lineWidth = 2;
    g.strokeRect(0, 0, a.widthMm * k, a.heightMm * k);
  }
  await drawLayers(g, { layers: s.layers[view.side], assets: s.assets, pxPerMm: k, originX: m.origin.x * k, originY: m.origin.y * k });
  return canvasBlob(canvas, "image/png");
}

// Rasters are labelled by their bytes, not the stored type, so drafts saved with an extension-based
// label still upload as what they are.
export function dataUrlBlob(dataUrl) {
  const [head, body] = dataUrl.split(",");
  const declared = head.slice(5).split(";")[0];
  const bytes = head.includes(";base64") ? Uint8Array.from(atob(body), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(body));
  const type = declared === "image/svg+xml" ? declared : (sniffImageType(bytes) ?? declared);
  return new Blob([bytes], { type });
}

const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg" };

// The files uploaded with an order: one per key of spec.files, in the order artwork, then mockup
// and print per view, then the sticker cut line. The spec itself is posted to /design, never
// uploaded.
export async function buildFiles(s, spec) {
  const files = [];
  for (const [key, meta] of Object.entries(spec.files)) {
    if (meta.role !== "artwork") continue;
    const a = s.assets[key];
    const blob = dataUrlBlob(a.dataUrl);
    files.push({ key, role: "artwork", name: `${key}.${EXT[blob.type] ?? EXT[a.type]}`, blob });
  }
  for (const view of spec.views) {
    const a = s.areas.find((x) => x.side === view.side);
    files.push({ key: `mockup-${view.side}`, role: "mockup", name: `mockup-${view.side}.png`, blob: await mockupPng(s, view) });
    const svg = s.product === "sticker"
      ? stickerSvg({ area: a, layers: s.layers.front, assets: s.assets, longestSideMm: s.sticker.longestSideMm, borderMm: PRODUCTS.sticker.borderMm, cutPathD: s.cutPathD ?? "" })
      : printSvg({ area: a, layers: s.layers[view.side], assets: s.assets });
    files.push({ key: `print-${view.side}`, role: "print", name: `print-${view.side}.svg`, blob: new Blob([svg], { type: "image/svg+xml" }) });
  }
  if (spec.files.cutline) {
    const L = s.sticker.longestSideMm;
    const cut = `<svg xmlns="http://www.w3.org/2000/svg" width="${L}mm" height="${L}mm" viewBox="0 0 ${L} ${L}"><g id="CutContour"><path d="${s.cutPathD}" fill="none" stroke="#ff00ff" stroke-width="0.1"/></g></svg>`;
    files.push({ key: "cutline", role: "cutline", name: "cutline.svg", blob: new Blob([cut], { type: "image/svg+xml" }) });
  }
  return files;
}
