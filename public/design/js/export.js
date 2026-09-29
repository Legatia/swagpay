// Print files as SVG strings at real size in millimetres. Pure: no DOM, so it is unit-tested.
export function escapeXml(s) {
  return String(s)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
}

const n = (v) => Math.round(v * 100) / 100;

export function layerMarkup(l, assets) {
  const cx = n(l.xMm + l.widthMm / 2);
  const cy = n(l.yMm + l.heightMm / 2);
  const rotate = `rotate(${n(l.rotationDeg)} ${cx} ${cy})`;
  if (l.type === "image") {
    const href = escapeXml(assets[l.file]?.dataUrl ?? "");
    return `<image href="${href}" x="${n(l.xMm)}" y="${n(l.yMm)}" width="${n(l.widthMm)}" height="${n(l.heightMm)}" preserveAspectRatio="none" transform="${rotate}"/>`;
  }
  const weight = Number.isInteger(l.weight) && isFinite(l.weight) ? l.weight : 400;
  const anchor = { left: "start", center: "middle", right: "end" }[l.align] ?? "middle";
  const x = l.align === "left" ? l.xMm : l.align === "right" ? l.xMm + l.widthMm : l.xMm + l.widthMm / 2;
  return `<text x="${n(x)}" y="${n(l.yMm + l.sizeMm)}" font-family="${escapeXml(l.font)}" font-weight="${weight}" font-size="${n(l.sizeMm)}" fill="${escapeXml(l.colour)}" text-anchor="${anchor}" transform="${rotate}">${escapeXml(l.text)}</text>`;
}

function svgOpen(w, h) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(w)}mm" height="${n(h)}mm" viewBox="0 0 ${n(w)} ${n(h)}">`;
}

export function printSvg({ area, layers, assets }) {
  return `${svgOpen(area.widthMm, area.heightMm)}${layers.map((l) => layerMarkup(l, assets)).join("")}</svg>`;
}

export function stickerSvg({ area, layers, assets, longestSideMm, borderMm, cutPathD }) {
  const art = layers.map((l) => layerMarkup(l, assets)).join("");
  const b = isFinite(borderMm) ? borderMm : 0;
  return (
    `${svgOpen(longestSideMm, longestSideMm)}` +
    `<path d="${escapeXml(cutPathD)}" fill="#ffffff"/>` +
    `<g transform="translate(${b} ${b})">${art}</g>` +
    `<g id="CutContour"><path d="${escapeXml(cutPathD)}" fill="none" stroke="#ff00ff" stroke-width="0.1"/></g>` +
    `</svg>`
  );
}
