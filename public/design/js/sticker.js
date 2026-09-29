// Sticker cut line: threshold the artwork's alpha, grow it by the border (Euclidean distance
// transform), fill holes, and trace one outline. Separate parts are wrapped in their convex hull so
// the printer gets a single continuous cut.
const INF = 1e20;

function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

export function dilate(mask, w, h, r) {
  if (r <= 0) return Uint8Array.from(mask);
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const g = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = mask[i] ? 0 : INF;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = g[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = g[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) g[y * w + x] = d[x];
  }
  const out = new Uint8Array(w * h);
  const r2 = r * r;
  for (let i = 0; i < w * h; i++) out[i] = g[i] <= r2 ? 1 : 0;
  return out;
}

export function fillHoles(mask, w, h) {
  const outside = new Uint8Array(w * h);
  const stack = [];
  const push = (x, y) => {
    const i = y * w + x;
    if (!mask[i] && !outside[i]) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w;
    const y = (i / w) | 0;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = outside[i] ? 0 : 1;
  return out;
}

function countComponents(mask, w, h) {
  const seen = new Uint8Array(w * h);
  let count = 0;
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || seen[s]) continue;
    count++;
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop();
      const x = i % w;
      const y = (i / w) | 0;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (mask[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
  }
  return count;
}

function hull(mask, w, h) {
  const pts = [];
  for (let y = 0; y < h; y++) {
    let left = -1;
    let right = -1;
    for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (left < 0) left = x; right = x; }
    if (left >= 0) { pts.push([left, y]); if (right !== left) pts.push([right, y]); }
  }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

function traceBoundary(mask, w, h) {
  let start = -1;
  for (let i = 0; i < w * h; i++) if (mask[i]) { start = i; break; }
  if (start < 0) return null;
  const sx = start % w;
  const sy = (start / w) | 0;
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  const pts = [[sx, sy]];
  let x = sx;
  let y = sy;
  let d = 0;
  for (let step = 0; step < 4 * w * h; step++) {
    let moved = false;
    for (let i = 0; i < 8; i++) {
      const nd = (d + 6 + i) % 8;
      const nx = x + DIRS[nd][0];
      const ny = y + DIRS[nd][1];
      if (at(nx, ny)) { x = nx; y = ny; d = nd; moved = true; break; }
    }
    if (!moved || (x === sx && y === sy)) break;
    pts.push([x, y]);
  }
  return pts;
}

export function traceOutline(alpha, w, h, { threshold = 128, dilatePx = 0 } = {}) {
  let mask = new Uint8Array(w * h);
  let any = false;
  for (let i = 0; i < w * h; i++) if (alpha[i] >= threshold) { mask[i] = 1; any = true; }
  if (!any) return null;
  mask = fillHoles(dilate(mask, w, h, dilatePx), w, h);
  if (countComponents(mask, w, h) > 1) return hull(mask, w, h);
  return traceBoundary(mask, w, h);
}

function perpendicular(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
}

function rdp(points, epsilon) {
  if (points.length < 3) return points;
  let index = 0;
  let max = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const dist = perpendicular(points[i], points[0], points[points.length - 1]);
    if (dist > max) { max = dist; index = i; }
  }
  if (max <= epsilon) return [points[0], points[points.length - 1]];
  return rdp(points.slice(0, index + 1), epsilon).slice(0, -1).concat(rdp(points.slice(index), epsilon));
}

export function simplify(points, epsilon) {
  if (points.length < 4) return points;
  const closed = rdp([...points, points[0]], epsilon);
  return closed.slice(0, -1);
}

const r2 = (n) => Math.round(n * 100) / 100;

export function smoothPathD(points, { scale, offsetX = 0, offsetY = 0 }) {
  const mm = points.map(([x, y]) => [(x - offsetX) / scale, (y - offsetY) / scale]);
  const n = mm.length;
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const start = mid(mm[n - 1], mm[0]);
  let d = `M${r2(start[0])} ${r2(start[1])}`;
  for (let i = 0; i < n; i++) {
    const p = mm[i];
    const m = mid(p, mm[(i + 1) % n]);
    d += `Q${r2(p[0])} ${r2(p[1])} ${r2(m[0])} ${r2(m[1])}`;
  }
  return `${d}Z`;
}

export function circlePathD(size) {
  const r = size / 2;
  return `M0 ${r}A${r} ${r} 0 1 0 ${size} ${r}A${r} ${r} 0 1 0 0 ${r}Z`;
}

export function roundedSquarePathD(size) {
  const r = r2(size * 0.12);
  const e = r2(size - r);
  return `M${r} 0H${e}A${r} ${r} 0 0 1 ${size} ${r}V${e}A${r} ${r} 0 0 1 ${e} ${size}H${r}A${r} ${r} 0 0 1 0 ${e}V${r}A${r} ${r} 0 0 1 ${r} 0Z`;
}

export function allowedShapes(layers, assets) {
  const opaque = layers.some((l) => l.type === "image" && !assets[l.file]?.hasAlpha);
  return opaque ? ["circle", "rounded-square"] : ["contour", "circle", "rounded-square"];
}
