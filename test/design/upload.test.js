import { describe, expect, it } from "vitest";
import { sniffImageType, svgAspect } from "../../public/design/js/upload.js";

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

describe("sniffImageType", () => {
  it("recognises PNG, JPEG and WebP by their first bytes", () => {
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toBe("image/png");
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]))).toBe("image/jpeg");
    const webp = [...new TextEncoder().encode("RIFF"), 1, 2, 3, 4, ...new TextEncoder().encode("WEBP")];
    expect(sniffImageType(new Uint8Array(webp))).toBe("image/webp");
  });
  it("returns null for anything else", () => {
    expect(sniffImageType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]))).toBeNull(); // GIF
    const wave = [...new TextEncoder().encode("RIFF"), 1, 2, 3, 4, ...new TextEncoder().encode("WAVE")];
    expect(sniffImageType(new Uint8Array(wave))).toBeNull();
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull(); // too short
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });
});
