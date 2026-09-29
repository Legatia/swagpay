import { describe, expect, it } from "vitest";
import { countPdfPages, imageSize, sniffMediaType } from "../src/sniff";

const enc = (s: string) => new TextEncoder().encode(s);

describe("sniffMediaType", () => {
  it("recognises the upload formats by their bytes", () => {
    expect(sniffMediaType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(sniffMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMediaType(enc("GIF89a...."))).toBe("image/gif");
    expect(sniffMediaType(enc("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "))).toBe("image/webp");
    expect(sniffMediaType(enc("%PDF-1.7\n"))).toBe("application/pdf");
    expect(sniffMediaType(enc('<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe("image/svg+xml");
    expect(sniffMediaType(enc('<?xml version="1.0"?><?xml-stylesheet href="a.css"?><svg></svg>'))).toBe("image/svg+xml");
    expect(sniffMediaType(enc('<!DOCTYPE svg [ <!ENTITY a "b"> ]>\n<svg></svg>'))).toBe("image/svg+xml");
    expect(sniffMediaType(enc(`<!-- ${"x".repeat(2000)} -->\n<svg></svg>`))).toBe("image/svg+xml");
    expect(sniffMediaType(enc("\uFEFF  <svg viewBox=\"0 0 1 1\"></svg>"))).toBe("image/svg+xml");
  });

  it("returns null for anything else", () => {
    expect(sniffMediaType(new Uint8Array(0))).toBeNull();
    expect(sniffMediaType(new Uint8Array(16))).toBeNull();
    expect(sniffMediaType(enc("<html><body>hi</body></html>"))).toBeNull();
    expect(sniffMediaType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull(); // truncated PNG signature
  });

  it("rejects crafted prefixes quickly", () => {
    const started = Date.now();
    expect(sniffMediaType(new TextEncoder().encode("<??>".repeat(1000) + "x"))).toBeNull();
    expect(sniffMediaType(new TextEncoder().encode("<!---->".repeat(500) + "x"))).toBeNull();
    expect(sniffMediaType(new TextEncoder().encode("<!DOCTYPE svg [" + "<".repeat(3000)))).toBeNull();
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe("countPdfPages", () => {
  it("counts page objects", () => {
    const pdf = "%PDF-1.4\n" + "1 0 obj << /Type /Pages /Kids [] /Count 3 >> endobj\n" + "2 0 obj << /Type /Page >> endobj\n".repeat(3);
    expect(countPdfPages(enc(pdf))).toBe(3);
  });

  it("falls back to the page tree count when page objects are compressed", () => {
    expect(countPdfPages(enc("%PDF-1.5\n1 0 obj << /Type /Pages /Kids [4 0 R] /Count 12 >> endobj\n"))).toBe(12);
  });

  it("returns null when it can't tell", () => {
    expect(countPdfPages(enc("%PDF-1.5\n(compressed)"))).toBeNull();
  });
});

describe("imageSize", () => {
  const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const png = (w: number, h: number) =>
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...u32be(w), ...u32be(h)]);
  const riff = (chunk: string, body: number[]) => new Uint8Array([...enc("RIFF"), 0, 0, 0, 0, ...enc("WEBP"), ...enc(chunk), 0, 0, 0, 0, ...body]);

  it("reads PNG, GIF, JPEG and WebP headers", () => {
    expect(imageSize(png(1200, 800), "image/png")).toEqual({ width: 1200, height: 800 });
    expect(imageSize(new Uint8Array([...enc("GIF89a"), 0x2c, 0x01, 0xc8, 0x00, 0, 0, 0]), "image/gif")).toEqual({ width: 300, height: 200 });
    const jpeg = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x10, ...enc("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0,
      0xff, 0xc0, 0x00, 0x11, 8, 0x01, 0xe0, 0x02, 0x80, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
    ]);
    expect(imageSize(jpeg, "image/jpeg")).toEqual({ width: 640, height: 480 });
    // VP8X: 24-bit little-endian width-1 and height-1.
    expect(imageSize(riff("VP8X", [0, 0, 0, 0, 0xcf, 0x07, 0x00, 0xe7, 0x03, 0x00]), "image/webp")).toEqual({ width: 2000, height: 1000 });
    // VP8L: signature 0x2f, then 14-bit width-1 and height-1.
    expect(imageSize(riff("VP8L", [0x2f, 0xaf, 0xc4, 0xc7, 0x00]), "image/webp")).toEqual({ width: 1200, height: 800 });
    // VP8: frame tag, start code, then 14-bit width and height.
    expect(imageSize(riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01]), "image/webp")).toEqual({ width: 640, height: 480 });
  });

  it("returns null when it can't read the size", () => {
    expect(imageSize(png(1200, 800).subarray(0, 20), "image/png")).toBeNull();
    const noIhdr = png(1200, 800);
    noIhdr.set(enc("IDAT"), 12);
    expect(imageSize(noIhdr, "image/png")).toBeNull();
    const noSof = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xda, 0x00, 0x04, 0, 0, 0xff, 0xd9]);
    expect(imageSize(noSof, "image/jpeg")).toBeNull();
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x7f, 0xff]), "image/jpeg")).toBeNull();
    expect(imageSize(enc("GIF89a"), "image/gif")).toBeNull();
    expect(imageSize(riff("VP8L", [0x00, 0xaf, 0xc4, 0xc7, 0x00]), "image/webp")).toBeNull();
    expect(imageSize(png(0, 800), "image/png")).toBeNull();
    expect(imageSize(png(1200, 800), "image/svg+xml")).toBeNull();
  });
});
