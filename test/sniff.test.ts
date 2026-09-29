import { describe, expect, it } from "vitest";
import { countPdfPages, sniffMediaType } from "../src/sniff";

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
