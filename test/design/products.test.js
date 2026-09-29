import { describe, expect, it } from "vitest";
import { OWNER_NOTE, PRODUCTS, SIZE_KEYS, cm, defaultOptions, dims, viewAreas } from "../../public/design/js/products.js";
import { effectiveDpi, layerQuality, maxWidthMm, qualityMessage } from "../../public/design/js/quality.js";

describe("products", () => {
  it("matches the backend's size keys", () => {
    expect(SIZE_KEYS).toEqual(["XS", "S", "M", "L", "XL", "XXL", "3XL"]);
  });
  it("gives the t-shirt front and back print areas of 28 x 38 cm", () => {
    expect(viewAreas("tshirt")).toEqual([
      { side: "front", widthMm: 280, heightMm: 380 },
      { side: "back", widthMm: 280, heightMm: 380 },
    ]);
  });
  it("makes the sticker artwork area the longest side minus the border on both sides", () => {
    expect(viewAreas("sticker", {}, { longestSideMm: 75 })).toEqual([{ side: "front", widthMm: 69, heightMm: 69 }]);
  });
  it("uses the chosen large-format preset, or the first one", () => {
    expect(viewAreas("banner", { size: "300x100" })).toEqual([{ side: "front", widthMm: 3000, heightMm: 1000 }]);
    expect(viewAreas("rollup", {})).toEqual([{ side: "front", widthMm: 850, heightMm: 2000 }]);
  });
  it("marks only large format as needing the owner", () => {
    expect(Object.values(PRODUCTS).filter((p) => p.needsOwner).map((p) => p.key)).toEqual(["banner", "rollup", "flag"]);
    expect(OWNER_NOTE).toBe("Needs the owner's confirmation before the agent quotes it.");
  });
  it("has default options per product", () => {
    expect(defaultOptions("tshirt")).toEqual({ colour: "black" });
    expect(defaultOptions("flag")).toEqual({ size: "100x150" });
    expect(defaultOptions("sticker")).toEqual({});
  });
  it("formats centimetres", () => {
    expect(cm(75)).toBe("7.5 cm");
    expect(cm(200)).toBe("20 cm");
    expect(dims(200, 120)).toBe("20 × 12 cm");
  });
  it("throws on an unknown product", () => {
    expect(() => viewAreas("hoodie")).toThrow("unknown product: hoodie");
  });
});

describe("quality", () => {
  const rule = { warn: 150, block: 100 };
  it("computes dpi from pixels and millimetres", () => {
    expect(Math.round(effectiveDpi(1500, 254))).toBe(150);
    expect(Math.round(maxWidthMm(1500, 150))).toBe(254);
  });
  it("passes vector artwork and text", () => {
    expect(layerQuality({ type: "image", widthMm: 250 }, { vector: true }, rule).status).toBe("ok");
    expect(layerQuality({ type: "text", widthMm: 250 }, null, rule).status).toBe("ok");
  });
  it("warns and blocks by the rule", () => {
    const asset = { vector: false, pixelWidth: 1000 };
    expect(layerQuality({ type: "image", widthMm: 150 }, asset, rule).status).toBe("ok");
    expect(layerQuality({ type: "image", widthMm: 200 }, asset, rule).status).toBe("warn");
    const q = layerQuality({ type: "image", widthMm: 300 }, asset, rule);
    expect(q).toEqual({ status: "block", dpi: 85, maxWidthMm: 169 });
  });
  it("explains a problem in plain words", () => {
    expect(qualityMessage({ status: "ok" }, "logo.png")).toBeNull();
    expect(qualityMessage({ status: "warn", dpi: 120, maxWidthMm: 169 }, "logo.png")).toBe("logo.png may print slightly soft at this size. For a sharp print, keep it under 16.9 cm wide.");
    expect(qualityMessage({ status: "block", dpi: 85, maxWidthMm: 169 }, "logo.png")).toBe("logo.png is too low-resolution for this size (85 dpi). Make it smaller than 16.9 cm wide, or upload a larger file.");
  });
});
