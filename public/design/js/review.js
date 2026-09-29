import { printSvg, stickerSvg } from "./export.js";
import { TEE, mockupFor } from "./mockups.js";
import { PRODUCTS } from "./products.js";
import { canvasBlob, drawLayers } from "./raster.js";
import { buildSpec, summarize } from "./spec.js";

const $ = (id) => document.getElementById(id);

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
    g.restore();
  } else {
    g.strokeStyle = "#171a38";
    g.lineWidth = 2;
    g.strokeRect(0, 0, a.widthMm * k, a.heightMm * k);
  }
  await drawLayers(g, { layers: s.layers[view.side], assets: s.assets, pxPerMm: k, originX: m.origin.x * k, originY: m.origin.y * k });
  return canvasBlob(canvas, "image/png");
}

function dataUrlBlob(dataUrl) {
  const [head, body] = dataUrl.split(",");
  const type = head.slice(5).split(";")[0];
  const bytes = head.includes(";base64") ? Uint8Array.from(atob(body), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(body));
  return new Blob([bytes], { type });
}

// The files that part 2 uploads with the order; for now they can be downloaded.
export async function buildFiles(s) {
  const { spec } = buildSpec(s);
  const files = [];
  for (const [key, meta] of Object.entries(spec.files)) {
    if (meta.role === "artwork") {
      const a = s.assets[key];
      const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg" }[a.type];
      files.push({ key, role: "artwork", name: `${key}.${ext}`, blob: dataUrlBlob(a.dataUrl) });
    }
  }
  for (const view of spec.views) {
    const a = s.areas.find((x) => x.side === view.side);
    files.push({ key: `mockup-${view.side}`, role: "mockup", name: `mockup-${view.side}.png`, blob: await mockupPng(s, view) });
    const svg = s.product === "sticker"
      ? stickerSvg({ area: a, layers: s.layers.front, assets: s.assets, longestSideMm: s.sticker.longestSideMm, borderMm: PRODUCTS.sticker.borderMm, cutPathD: s.cutPathD ?? "" })
      : printSvg({ area: a, layers: s.layers[view.side], assets: s.assets });
    files.push({ key: `print-${view.side}`, role: "print", name: `print-${view.side}.svg`, blob: new Blob([svg], { type: "image/svg+xml" }) });
  }
  if (s.product === "sticker" && s.cutPathD) {
    const L = s.sticker.longestSideMm;
    const cut = `<svg xmlns="http://www.w3.org/2000/svg" width="${L}mm" height="${L}mm" viewBox="0 0 ${L} ${L}"><g id="CutContour"><path d="${s.cutPathD}" fill="none" stroke="#ff00ff" stroke-width="0.1"/></g></svg>`;
    files.push({ key: "cutline", role: "cutline", name: "cutline.svg", blob: new Blob([cut], { type: "image/svg+xml" }) });
  }
  files.push({ key: "spec", role: "spec", name: "design.json", blob: new Blob([JSON.stringify(spec, null, 2)], { type: "application/json" }) });
  return files;
}

export function renderReview(s) {
  const { spec, error } = buildSpec(s);
  $("summary").textContent = error ?? summarize(spec);
  const box = $("downloads");
  box.replaceChildren();
  if (error) return;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "secondary";
  b.textContent = "Prepare files";
  b.addEventListener("click", async () => {
    b.disabled = true;
    b.textContent = "Preparing…";
    try {
      const files = await buildFiles(s);
      box.replaceChildren(
        ...files.map((f) => {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(f.blob);
          a.download = f.name;
          a.className = "chip";
          a.textContent = f.name;
          return a;
        }),
      );
      box.querySelector("a")?.focus();
    } catch (err) {
      b.disabled = false;
      b.textContent = "Prepare files";
      $("notice").textContent = err.message;
    }
  });
  box.append(b);
}
