import { describe, expect, it } from "vitest";
import { svgAspect } from "../../public/design/js/upload.js";

describe("svgAspect", () => {
  it("reads the viewBox when there is no width or height", () => {
    expect(svgAspect('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"><path d="M0 0"/></svg>')).toBe(4);
    expect(svgAspect("<?xml version='1.0'?><svg viewBox='10,20,300,150'></svg>")).toBe(2);
  });
  it("prefers the viewBox over width and height", () => {
    expect(svgAspect('<svg width="10" height="10" viewBox="0 0 200 100"/>')).toBe(2);
  });
  it("falls back to numeric width and height", () => {
    expect(svgAspect('<svg width="300" height="100"></svg>')).toBe(3);
    expect(svgAspect('<svg width="300px" height="150px"></svg>')).toBe(2);
  });
  it("ignores stroke-width and percentages", () => {
    expect(svgAspect('<svg stroke-width="9" width="100%" height="100%"></svg>')).toBeNull();
  });
  it("returns null when there is no usable size", () => {
    expect(svgAspect("<svg></svg>")).toBeNull();
    expect(svgAspect('<svg viewBox="0 0 0 0"></svg>')).toBeNull();
    expect(svgAspect("not an svg")).toBeNull();
  });
});
