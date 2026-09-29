import { describe, expect, it } from "vitest";
import { clampToArea, fitInside, normalizeDeg, pinchTransform, rotatedBounds, round1 } from "../../public/design/js/geometry.js";

const area = { widthMm: 280, heightMm: 380 };

describe("normalizeDeg", () => {
  it("wraps into [-180, 180)", () => {
    expect(normalizeDeg(190)).toBe(-170);
    expect(normalizeDeg(-190)).toBe(170);
    expect(normalizeDeg(360)).toBe(0);
    expect(normalizeDeg(45)).toBe(45);
  });
});

describe("rotatedBounds", () => {
  it("is the rectangle itself without rotation", () => {
    expect(rotatedBounds({ xMm: 10, yMm: 20, widthMm: 100, heightMm: 50, rotationDeg: 0 })).toEqual({ minX: 10, minY: 20, maxX: 110, maxY: 70 });
  });
  it("swaps width and height at 90 degrees, around the centre", () => {
    const b = rotatedBounds({ xMm: 0, yMm: 0, widthMm: 100, heightMm: 50, rotationDeg: 90 });
    expect(round1(b.minX)).toBe(25);
    expect(round1(b.maxX)).toBe(75);
    expect(round1(b.minY)).toBe(-25);
    expect(round1(b.maxY)).toBe(75);
  });
});

describe("clampToArea", () => {
  it("leaves a layer inside the area alone", () => {
    const layer = { xMm: 10, yMm: 10, widthMm: 100, heightMm: 100, rotationDeg: 0 };
    expect(clampToArea(layer, area)).toEqual({ layer, clamped: false });
  });
  it("moves a layer back inside", () => {
    const { layer, clamped } = clampToArea({ xMm: 250, yMm: -30, widthMm: 100, heightMm: 100, rotationDeg: 0 }, area);
    expect(clamped).toBe(true);
    expect(layer.xMm).toBe(180);
    expect(layer.yMm).toBe(0);
  });
  it("keeps the rotated corners inside too", () => {
    const { layer } = clampToArea({ xMm: 200, yMm: 10, widthMm: 80, heightMm: 80, rotationDeg: 45 }, area);
    const b = rotatedBounds(layer);
    expect(b.maxX).toBeLessThanOrEqual(280 + 1e-9);
    expect(b.minY).toBeGreaterThanOrEqual(-1e-9);
  });
  it("shrinks a layer that is larger than the area", () => {
    const { layer, clamped } = clampToArea({ xMm: 0, yMm: 0, widthMm: 560, heightMm: 190, rotationDeg: 0 }, area);
    expect(clamped).toBe(true);
    expect(round1(layer.widthMm)).toBe(280);
    expect(round1(layer.heightMm)).toBe(95);
    expect(layer.xMm).toBeGreaterThanOrEqual(-1e-9);
  });
});

describe("pinchTransform", () => {
  it("measures scale, rotation and translation of two pointers", () => {
    const t = pinchTransform({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 }, { x: 5, y: 25 });
    expect(t.scale).toBe(2);
    expect(round1(t.rotationDeg)).toBe(90);
    expect(t.dx).toBe(0);
    expect(t.dy).toBe(15);
  });
  it("does not divide by zero when both pointers start in the same place", () => {
    expect(pinchTransform({ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }).scale).toBe(1);
  });
});

describe("fitInside", () => {
  it("fits a wide image by width and a tall one by height", () => {
    expect(fitInside(2, 100, 100)).toEqual({ widthMm: 100, heightMm: 50 });
    expect(fitInside(0.5, 100, 100)).toEqual({ widthMm: 50, heightMm: 100 });
  });
});
