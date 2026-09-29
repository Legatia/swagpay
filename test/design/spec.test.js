import { describe, expect, it } from "vitest";
import { SPEC_MAX_BYTES, buildSpec, specSize, summarize } from "../../public/design/js/spec.js";

const logo = { id: "a", type: "image", file: "logo-1", xMm: 40, yMm: 30, widthMm: 200, heightMm: 120, rotationDeg: 0 };
const words = { id: "b", type: "text", text: "Builders meetup", font: "Big Shoulders Display", weight: 800, colour: "#FFFFFF", sizeMm: 18, align: "center", xMm: 40, yMm: 170, widthMm: 200, heightMm: 22.5, rotationDeg: 0 };
const base = {
  product: "tshirt",
  options: { colour: "black" },
  sticker: { longestSideMm: 75, shape: "contour" },
  areas: [{ side: "front", widthMm: 280, heightMm: 380 }, { side: "back", widthMm: 280, heightMm: 380 }],
  layers: { front: [logo, words], back: [] },
  assets: { "logo-1": { name: "logo.png", vector: false, pixelWidth: 1670, pixelHeight: 1000 } },
  sizes: { S: 10, M: 20, L: 20, XL: 10 },
  quantity: 0,
  estimate: { status: "ok", currency: "USD", low: 410, high: 450 },
};

describe("buildSpec", () => {
  it("builds the v1 spec the backend validates", () => {
    const { spec } = buildSpec(base);
    expect(spec).toEqual({
      version: 1,
      product: "tshirt",
      options: { colour: "black" },
      views: [{
        side: "front",
        printArea: { widthMm: 280, heightMm: 380 },
        layers: [
          { type: "image", file: "logo-1", xMm: 40, yMm: 30, widthMm: 200, heightMm: 120, rotationDeg: 0, effectiveDpi: 212 },
          { type: "text", text: "Builders meetup", font: "Big Shoulders Display", weight: 800, colour: "#FFFFFF", sizeMm: 18, xMm: 40, yMm: 170, widthMm: 200, rotationDeg: 0, align: "center" },
        ],
      }],
      sizes: { S: 10, M: 20, L: 20, XL: 10 },
      quantity: 60,
      sticker: null,
      estimate: { currency: "USD", low: 410, high: 450 },
      files: { "logo-1": { role: "artwork" }, "mockup-front": { role: "mockup" }, "print-front": { role: "print" } },
    });
  });
  it("cleans up junk in sizes", () => {
    const { spec } = buildSpec({ ...base, sizes: { S: "abc", M: "-5", L: "2.7", XL: 3 } });
    expect(spec.sizes).toEqual({ L: 2, XL: 3 });
    expect(spec.quantity).toBe(5);
  });
  it("asks for a quantity when there is none", () => {
    expect(buildSpec({ ...base, sizes: {} })).toEqual({ error: "Enter how many you need." });
    expect(buildSpec({ ...base, product: "banner", options: { size: "200x100" }, quantity: "0" })).toEqual({ error: "Enter how many you need." });
  });
  it("refuses more than 5,000 pieces", () => {
    expect(buildSpec({ ...base, sizes: { M: 5001 } })).toEqual({ error: "Orders go up to 5,000 pieces. For more, describe it to the agent." });
  });
  it("needs at least one layer", () => {
    expect(buildSpec({ ...base, layers: { front: [], back: [] } })).toEqual({ error: "Add a logo or some text before continuing." });
  });
  it("describes a sticker and adds the cut line file", () => {
    const { spec } = buildSpec({ ...base, product: "sticker", options: {}, areas: [{ side: "front", widthMm: 69, heightMm: 69 }], layers: { front: [{ ...logo, widthMm: 60, heightMm: 36 }] }, quantity: 500, estimate: { status: "quote" } });
    expect(spec.sticker).toEqual({ longestSideMm: 75, shape: "contour", borderMm: 3 });
    expect(spec.sizes).toBeNull();
    expect(spec.estimate).toBeNull();
    expect(spec.files.cutline).toEqual({ role: "cutline" });
  });
  it("leaves effectiveDpi out for vector images", () => {
    const { spec } = buildSpec({ ...base, assets: { "logo-1": { name: "logo.svg", vector: true } } });
    expect("effectiveDpi" in spec.views[0].layers[0]).toBe(false);
  });
  it("drops empty text and trims text", () => {
    const { spec } = buildSpec({ ...base, layers: { front: [logo, { ...words, text: "   " }, { ...words, id: "c", text: "  Hi  " }], back: [] } });
    expect(spec.views[0].layers.map((l) => l.text ?? l.file)).toEqual(["logo-1", "Hi"]);
  });
  it("allows at most 20 layers per side", () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ ...words, id: `t${i}` }));
    expect(buildSpec({ ...base, layers: { front: many, back: [] } })).toEqual({ error: "A side can have at most 20 layers." });
  });
  it("allows at most 10 files per order", () => {
    const logos = Array.from({ length: 7 }, (_, i) => ({ ...logo, id: `i${i}`, file: `logo-${i + 1}` }));
    const assets = Object.fromEntries(logos.map((l) => [l.file, { name: `${l.file}.png`, vector: false, pixelWidth: 2000, pixelHeight: 1000 }]));
    // 7 artwork + mockup-front + print-front + mockup-back + print-back = 11
    expect(buildSpec({ ...base, assets, layers: { front: logos, back: [words] } })).toEqual({ error: "Too many images for one order. Use at most 6 different logos." });
  });
  it("refuses a spec over 64 KB", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...words, id: `t${i}`, text: "x".repeat(200) }));
    const huge = { ...base, options: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`k${i}`, "v".repeat(60)])), layers: { front: many, back: many } };
    expect(buildSpec(huge)).toEqual({ error: "This design is too large to send. Remove a text layer or two." });
    expect(SPEC_MAX_BYTES).toBe(65536);
    expect(specSize({ a: "é" })).toBe(10);
  });
});

describe("summarize", () => {
  it("writes a t-shirt order in plain words", () => {
    expect(summarize(buildSpec(base).spec)).toBe('60 black t-shirts (S 10, M 20, L 20, XL 10). Front: logo 20 × 12 cm, the text "Builders meetup". Back: blank. Estimate $410–450.');
  });
  it("writes a sticker order", () => {
    const { spec } = buildSpec({ ...base, product: "sticker", options: {}, areas: [{ side: "front", widthMm: 69, heightMm: 69 }], layers: { front: [{ ...logo, widthMm: 60, heightMm: 36 }] }, quantity: 500, estimate: { status: "quote" } });
    expect(summarize(spec)).toBe("500 die-cut stickers, 7.5 cm on the longest side, following the logo, with a 3 mm white border. Front: logo 6 × 3.6 cm. The agent will quote the price.");
  });
  it("marks large format as needing the owner", () => {
    const { spec } = buildSpec({ ...base, product: "rollup", options: { size: "85x200" }, areas: [{ side: "front", widthMm: 850, heightMm: 2000 }], layers: { front: [logo] }, quantity: 2, estimate: { status: "quote" } });
    expect(summarize(spec)).toBe("2 × roll-up 85 × 200 cm. Front: logo 20 × 12 cm. The agent will quote the price. Needs the owner's confirmation before the agent quotes it.");
  });
});
