import { fitInside, normalizeDeg } from "./geometry.js";

let counter = 0;
export function newId() {
  counter += 1;
  return `l${Date.now().toString(36)}${counter}`;
}

export function nextAssetKey(assets) {
  let i = 1;
  while (assets[`logo-${i}`]) i++;
  return `logo-${i}`;
}

export function newImageLayer(file, asset, area) {
  const aspect = asset.pixelWidth && asset.pixelHeight ? asset.pixelWidth / asset.pixelHeight : 1;
  const size = fitInside(aspect, area.widthMm * 0.6, area.heightMm * 0.6);
  return {
    id: newId(),
    type: "image",
    file,
    xMm: (area.widthMm - size.widthMm) / 2,
    yMm: (area.heightMm - size.heightMm) / 2,
    widthMm: size.widthMm,
    heightMm: size.heightMm,
    rotationDeg: 0,
  };
}

export function newTextLayer(area, { text = "Your text", colour = "#171a38" } = {}) {
  const sizeMm = Math.max(6, Math.round(area.heightMm * 0.06));
  const widthMm = Math.min(area.widthMm * 0.9, text.length * sizeMm * 0.55);
  const heightMm = sizeMm * 1.25;
  return {
    id: newId(),
    type: "text",
    text,
    font: "Figtree",
    weight: 700,
    colour,
    sizeMm,
    align: "center",
    xMm: (area.widthMm - widthMm) / 2,
    yMm: (area.heightMm - heightMm) / 2,
    widthMm,
    heightMm,
    rotationDeg: 0,
  };
}

const MIN_WIDTH_MM = 5;

export function transformLayer(layer, { scale = 1, rotationDeg = 0, dx = 0, dy = 0 }) {
  const k = Math.max(scale, MIN_WIDTH_MM / layer.widthMm);
  const cx = layer.xMm + layer.widthMm / 2 + dx;
  const cy = layer.yMm + layer.heightMm / 2 + dy;
  const widthMm = layer.widthMm * k;
  const heightMm = layer.heightMm * k;
  const next = {
    ...layer,
    widthMm,
    heightMm,
    xMm: cx - widthMm / 2,
    yMm: cy - heightMm / 2,
    rotationDeg: normalizeDeg(layer.rotationDeg + rotationDeg),
  };
  if (layer.type === "text") next.sizeMm = layer.sizeMm * k;
  return next;
}

function mapSide(state, side, fn) {
  return { ...state, layers: { ...state.layers, [side]: fn(state.layers[side] || []) } };
}

export function updateLayer(state, side, id, patch) {
  return mapSide(state, side, (list) => list.map((l) => (l.id === id ? { ...l, ...patch } : l)));
}

export function replaceLayer(state, side, layer) {
  return mapSide(state, side, (list) => list.map((l) => (l.id === layer.id ? layer : l)));
}

export function removeLayer(state, side, id) {
  return { ...mapSide(state, side, (list) => list.filter((l) => l.id !== id)), selectedId: state.selectedId === id ? null : state.selectedId };
}

export function findLayer(state, side, id) {
  return (state.layers[side] || []).find((l) => l.id === id) || null;
}
