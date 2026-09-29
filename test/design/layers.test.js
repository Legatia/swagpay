import { describe, expect, it } from "vitest";
import { findLayer, newImageLayer, newTextLayer, nextAssetKey, removeLayer, replaceLayer, transformLayer, updateLayer } from "../../public/design/js/layers.js";
import { MAX_UPLOAD_BYTES, validateUpload } from "../../public/design/js/upload.js";
import { escapeXml, printSvg, stickerSvg } from "../../public/design/js/export.js";
import { mockupFor } from "../../public/design/js/mockups.js";

const area = { widthMm: 280, heightMm: 380 };

describe("layers", () => {
  it("names assets logo-1, logo-2 ...", () => {
    expect(nextAssetKey({})).toBe("logo-1");
    expect(nextAssetKey({ "logo-1": {}, "logo-3": {} })).toBe("logo-2");
  });
  it("places a new logo centred at 60% of the area", () => {
    const l = newImageLayer("logo-1", { pixelWidth: 2000, pixelHeight: 1000 }, area);
    expect(l).toMatchObject({ type: "image", file: "logo-1", widthMm: 168, heightMm: 84, xMm: 56, yMm: 148, rotationDeg: 0 });
  });
  it("adds text centred in the area", () => {
    const t = newTextLayer(area, { text: "Hello", colour: "#ffffff" });
    expect(t).toMatchObject({ type: "text", text: "Hello", font: "Figtree", weight: 700, colour: "#ffffff", align: "center", rotationDeg: 0 });
    expect(t.xMm + t.widthMm / 2).toBeCloseTo(140);
  });
  it("scales about the centre, rotates and moves", () => {
    const l = { id: "a", type: "image", xMm: 0, yMm: 0, widthMm: 100, heightMm: 50, rotationDeg: 170 };
    const t = transformLayer(l, { scale: 2, rotationDeg: 30, dx: 5, dy: -5 });
    expect(t).toMatchObject({ xMm: -45, yMm: -30, widthMm: 200, heightMm: 100, rotationDeg: -160 });
  });
  it("scales text size with the box and never goes below 5 mm wide", () => {
    const t = transformLayer({ type: "text", sizeMm: 10, xMm: 0, yMm: 0, widthMm: 40, heightMm: 12.5, rotationDeg: 0 }, { scale: 0.01 });
    expect(t.widthMm).toBe(5);
    expect(t.sizeMm).toBeCloseTo(1.25);
  });
  it("updates, replaces, finds and removes layers per side", () => {
    let s = { layers: { front: [{ id: "a", xMm: 0 }], back: [] }, selectedId: "a" };
    s = updateLayer(s, "front", "a", { xMm: 9 });
    expect(findLayer(s, "front", "a").xMm).toBe(9);
    s = replaceLayer(s, "front", { id: "a", xMm: 3 });
    expect(findLayer(s, "front", "a").xMm).toBe(3);
    s = removeLayer(s, "front", "a");
    expect(s.layers.front).toEqual([]);
    expect(s.selectedId).toBeNull();
  });
});

describe("uploads", () => {
  it("accepts the allowed types up to 10 MB", () => {
    expect(validateUpload({ type: "image/png", size: 9_000_000 })).toBeNull();
    expect(validateUpload({ type: "image/svg+xml", size: 2000 })).toBeNull();
    expect(validateUpload({ type: "application/pdf", size: 2000 })).toBe("Upload a PNG, JPEG, WebP or SVG file.");
    expect(validateUpload({ type: "image/png", size: MAX_UPLOAD_BYTES + 1 })).toBe("Files can be up to 10 MB.");
  });
});

describe("export", () => {
  const assets = { "logo-1": { dataUrl: "data:image/png;base64,AAAA" } };
  const layers = [
    { id: "a", type: "image", file: "logo-1", xMm: 10, yMm: 20, widthMm: 100, heightMm: 50, rotationDeg: 0 },
    { id: "b", type: "text", text: `Tom & "Jerry" <3`, font: "Figtree", weight: 700, colour: "#171a38", sizeMm: 10, align: "center", xMm: 10, yMm: 100, widthMm: 100, heightMm: 12.5, rotationDeg: 15 },
  ];
  it("escapes text", () => {
    expect(escapeXml(`a<b>&"c'`)).toBe("a&lt;b&gt;&amp;&quot;c&apos;");
  });
  it("writes a real-size print SVG", () => {
    const svg = printSvg({ area, layers, assets });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('width="280mm" height="380mm" viewBox="0 0 280 380"');
    expect(svg).toContain('href="data:image/png;base64,AAAA"');
    expect(svg).toContain("Tom &amp; &quot;Jerry&quot; &lt;3");
    expect(svg).toContain('rotate(15 60 106.25)');
    expect(svg).not.toContain("<3<");
  });
  it("writes a sticker SVG with a CutContour layer", () => {
    const svg = stickerSvg({ area: { widthMm: 69, heightMm: 69 }, layers: [layers[0]], assets, longestSideMm: 75, borderMm: 3, cutPathD: "M0 0Z" });
    expect(svg).toContain('width="75mm" height="75mm" viewBox="0 0 75 75"');
    expect(svg).toContain('<g id="CutContour"><path d="M0 0Z" fill="none" stroke="#ff00ff" stroke-width="0.1"/></g>');
    expect(svg).toContain('transform="translate(3 3)"');
  });
});

describe("mockups", () => {
  it("places the t-shirt print areas on the shirt", () => {
    expect(mockupFor("tshirt", "front", area)).toEqual({ viewBox: [0, 0, 560, 720], origin: { x: 140, y: 150 }, kind: "tee" });
    expect(mockupFor("tshirt", "back", area).origin).toEqual({ x: 140, y: 130 });
  });
  it("frames large format with a margin", () => {
    const m = mockupFor("banner", "front", { widthMm: 2000, heightMm: 1000 });
    expect(m.kind).toBe("banner");
    expect(m.viewBox).toEqual([-160, -160, 2320, 1320]);
    expect(mockupFor("rollup", "front", { widthMm: 850, heightMm: 2000 }).viewBox[3]).toBe(2000 + 320 + 100);
  });
});
