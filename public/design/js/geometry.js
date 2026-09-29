// Geometry in millimetres. A layer is { xMm, yMm, widthMm, heightMm, rotationDeg }, rotated about
// its centre; an area is { widthMm, heightMm } with its origin at the top-left.
export const DEG = Math.PI / 180;
const EPS = 1e-9;

export function normalizeDeg(deg) {
  const x = ((((deg + 180) % 360) + 360) % 360) - 180;
  return Object.is(x, -0) ? 0 : x;
}

export function round1(n) {
  return Math.round(n * 10) / 10;
}

export function rotatedBounds({ xMm, yMm, widthMm, heightMm, rotationDeg = 0 }) {
  const cx = xMm + widthMm / 2;
  const cy = yMm + heightMm / 2;
  const r = rotationDeg * DEG;
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  const hw = (widthMm * c + heightMm * s) / 2;
  const hh = (widthMm * s + heightMm * c) / 2;
  return { minX: cx - hw, minY: cy - hh, maxX: cx + hw, maxY: cy + hh };
}

export function clampToArea(layer, area) {
  let l = { ...layer };
  let clamped = false;
  let b = rotatedBounds(l);
  const k = Math.min(1, area.widthMm / (b.maxX - b.minX), area.heightMm / (b.maxY - b.minY));
  if (k < 1 - EPS) {
    const cx = l.xMm + l.widthMm / 2;
    const cy = l.yMm + l.heightMm / 2;
    l.widthMm *= k;
    l.heightMm *= k;
    if (l.sizeMm != null) l.sizeMm *= k;
    l.xMm = cx - l.widthMm / 2;
    l.yMm = cy - l.heightMm / 2;
    clamped = true;
    b = rotatedBounds(l);
  }
  let dx = 0;
  let dy = 0;
  if (b.minX < -EPS) dx = -b.minX;
  else if (b.maxX > area.widthMm + EPS) dx = area.widthMm - b.maxX;
  if (b.minY < -EPS) dy = -b.minY;
  else if (b.maxY > area.heightMm + EPS) dy = area.heightMm - b.maxY;
  if (dx || dy) {
    l.xMm += dx;
    l.yMm += dy;
    clamped = true;
  }
  return clamped ? { layer: l, clamped } : { layer, clamped };
}

export function pinchTransform(a0, b0, a1, b1) {
  const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y);
  const d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y);
  const ang0 = Math.atan2(b0.y - a0.y, b0.x - a0.x);
  const ang1 = Math.atan2(b1.y - a1.y, b1.x - a1.x);
  return {
    scale: d0 > EPS ? d1 / d0 : 1,
    rotationDeg: d0 > EPS && d1 > EPS ? normalizeDeg((ang1 - ang0) / DEG) : 0,
    dx: (a1.x + b1.x) / 2 - (a0.x + b0.x) / 2,
    dy: (a1.y + b1.y) / 2 - (a0.y + b0.y) / 2,
  };
}

export function fitInside(aspect, maxW, maxH) {
  let widthMm = maxW;
  let heightMm = widthMm / aspect;
  if (heightMm > maxH) {
    heightMm = maxH;
    widthMm = heightMm * aspect;
  }
  return { widthMm, heightMm };
}
