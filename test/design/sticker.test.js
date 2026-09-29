import { describe, expect, it } from "vitest";
import { allowedShapes, circlePathD, dilate, fillHoles, roundedSquarePathD, simplify, smoothPathD, traceOutline } from "../../public/design/js/sticker.js";

function grid(w, h, fill) {
  const a = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (fill(x, y)) a[y * w + x] = 255;
  return a;
}
const bbox = (pts) => ({
  minX: Math.min(...pts.map((p) => p[0])), maxX: Math.max(...pts.map((p) => p[0])),
  minY: Math.min(...pts.map((p) => p[1])), maxY: Math.max(...pts.map((p) => p[1])),
});

describe("masks", () => {
  it("dilates by a radius", () => {
    const m = grid(20, 20, (x, y) => x >= 8 && x <= 11 && y >= 8 && y <= 11).map((v) => (v ? 1 : 0));
    const d = dilate(m, 20, 20, 2);
    expect(d[8 * 20 + 6]).toBe(1);
    expect(d[8 * 20 + 5]).toBe(0);
    expect(d[6 * 20 + 6]).toBe(0); // corner is further than 2 px
  });
  it("fills holes", () => {
    const ring = grid(12, 12, (x, y) => x >= 2 && x <= 9 && y >= 2 && y <= 9 && !(x >= 4 && x <= 7 && y >= 4 && y <= 7)).map((v) => (v ? 1 : 0));
    const f = fillHoles(ring, 12, 12);
    expect(f[5 * 12 + 5]).toBe(1);
    expect(f[0]).toBe(0);
  });
});

describe("traceOutline", () => {
  it("returns null for an empty image", () => {
    expect(traceOutline(new Uint8ClampedArray(100), 10, 10)).toBeNull();
  });
  it("traces a square", () => {
    const pts = traceOutline(grid(20, 20, (x, y) => x >= 5 && x <= 14 && y >= 5 && y <= 14), 20, 20);
    expect(bbox(pts)).toEqual({ minX: 5, maxX: 14, minY: 5, maxY: 14 });
  });
  it("ignores holes, so the cut is one outline", () => {
    const pts = traceOutline(grid(20, 20, (x, y) => x >= 3 && x <= 16 && y >= 3 && y <= 16 && !(x >= 7 && x <= 12 && y >= 7 && y <= 12)), 20, 20);
    expect(bbox(pts)).toEqual({ minX: 3, maxX: 16, minY: 3, maxY: 16 });
    expect(simplify(pts, 1).length).toBeLessThanOrEqual(6);
  });
  it("wraps separate parts in one outline", () => {
    const pts = traceOutline(grid(30, 20, (x, y) => (x >= 2 && x <= 8 && y >= 2 && y <= 8) || (x >= 20 && x <= 27 && y >= 10 && y <= 17)), 30, 20);
    expect(bbox(pts)).toEqual({ minX: 2, maxX: 27, minY: 2, maxY: 17 });
  });
  it("grows by the border", () => {
    const pts = traceOutline(grid(30, 30, (x, y) => x >= 10 && x <= 19 && y >= 10 && y <= 19), 30, 30, { dilatePx: 3 });
    expect(bbox(pts)).toEqual({ minX: 7, maxX: 22, minY: 7, maxY: 22 });
  });
  it("stays fast on a large mask", () => {
    const t = Date.now();
    traceOutline(grid(700, 700, (x, y) => (x - 350) ** 2 + (y - 350) ** 2 < 250 ** 2), 700, 700, { dilatePx: 24 });
    expect(Date.now() - t).toBeLessThan(3000);
  });
});

describe("paths and shapes", () => {
  it("turns points into a closed path in millimetres", () => {
    const d = smoothPathD([[8, 8], [24, 8], [24, 24], [8, 24]], { scale: 8, offsetX: 0, offsetY: 0 });
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(d).toContain("Q3 1 ");
  });
  it("draws a circle and a rounded square filling the sticker", () => {
    expect(circlePathD(50)).toBe("M0 25A25 25 0 1 0 50 25A25 25 0 1 0 0 25Z");
    expect(roundedSquarePathD(50)).toBe("M6 0H44A6 6 0 0 1 50 6V44A6 6 0 0 1 44 50H6A6 6 0 0 1 0 44V6A6 6 0 0 1 6 0Z");
  });
  it("only offers the contour when every image has transparency", () => {
    const layers = [{ type: "image", file: "a" }, { type: "text" }];
    expect(allowedShapes(layers, { a: { hasAlpha: true } })).toEqual(["contour", "circle", "rounded-square"]);
    expect(allowedShapes(layers, { a: { hasAlpha: false } })).toEqual(["circle", "rounded-square"]);
  });
});
