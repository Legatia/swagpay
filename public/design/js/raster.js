// Draws layers onto a canvas with the Canvas API (not SVG-as-image), so web fonts render and the
// canvas is never tainted. Used for the sticker cut line and the mockup PNG.
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("An image could not be drawn."));
    img.src = src;
  });
}

export async function drawLayers(g, { layers, assets, pxPerMm, originX = 0, originY = 0 }) {
  for (const l of layers) {
    const cx = originX + (l.xMm + l.widthMm / 2) * pxPerMm;
    const cy = originY + (l.yMm + l.heightMm / 2) * pxPerMm;
    g.save();
    g.translate(cx, cy);
    g.rotate((l.rotationDeg * Math.PI) / 180);
    if (l.type === "image") {
      const img = await loadImage(assets[l.file].dataUrl);
      g.drawImage(img, (-l.widthMm / 2) * pxPerMm, (-l.heightMm / 2) * pxPerMm, l.widthMm * pxPerMm, l.heightMm * pxPerMm);
    } else {
      const size = l.sizeMm * pxPerMm;
      await document.fonts.load(`${l.weight} ${Math.max(1, Math.round(size))}px "${l.font}"`).catch(() => {});
      g.font = `${l.weight} ${size}px "${l.font}"`;
      g.fillStyle = l.colour;
      g.textAlign = l.align === "left" ? "left" : l.align === "right" ? "right" : "center";
      g.textBaseline = "alphabetic";
      const x = l.align === "left" ? (-l.widthMm / 2) * pxPerMm : l.align === "right" ? (l.widthMm / 2) * pxPerMm : 0;
      g.fillText(l.text, x, (-l.heightMm / 2 + l.sizeMm) * pxPerMm);
    }
    g.restore();
  }
}

export async function rasterize({ area, layers, assets, pxPerMm, padPx = 0 }) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(area.widthMm * pxPerMm + 2 * padPx);
  canvas.height = Math.ceil(area.heightMm * pxPerMm + 2 * padPx);
  const g = canvas.getContext("2d");
  await drawLayers(g, { layers, assets, pxPerMm, originX: padPx, originY: padPx });
  return canvas;
}

export function canvasBlob(canvas, type = "image/png") {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Export failed."))), type));
}
