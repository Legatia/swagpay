import { binaryString } from "./ids";

const startsWith = (b: Uint8Array, sig: number[], offset = 0) =>
  b.length >= offset + sig.length && sig.every((v, i) => b[offset + i] === v);

/** True when the text starts with an <svg> element after an optional BOM, whitespace, processing instructions, comments and a DOCTYPE. Linear time. */
function startsWithSvg(text: string): boolean {
  let s = text.replace(/^\uFEFF/, "");
  for (;;) {
    s = s.trimStart();
    if (s.startsWith("<?")) {
      const end = s.indexOf("?>", 2);
      if (end < 0) return false;
      s = s.slice(end + 2);
    } else if (s.startsWith("<!--")) {
      const end = s.indexOf("-->", 4);
      if (end < 0) return false;
      s = s.slice(end + 3);
    } else if (/^<!DOCTYPE\s+svg\b/i.test(s)) {
      const close = s.indexOf(">");
      const open = s.indexOf("[");
      const end = open >= 0 && open < close ? s.indexOf(">", s.indexOf("]", open)) : close;
      if (end < 0 || (open >= 0 && open < close && s.indexOf("]", open) < 0)) return false;
      s = s.slice(end + 1);
    } else {
      return /^<svg[\s>]/i.test(s);
    }
  }
}

/** The media type a file's bytes actually are, or null when unrecognised. */
export function sniffMediaType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return "image/gif";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  const head = new TextDecoder().decode(bytes.subarray(0, 4096));
  if (startsWithSvg(head)) return "image/svg+xml";
  return null;
}

/** Page count of a PDF when it can be read without decompressing, else null. */
export function countPdfPages(bytes: Uint8Array): number | null {
  const text = binaryString(bytes);
  const pageObjects = text.match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
  if (pageObjects > 0) return pageObjects;
  let max = 0;
  for (const m of text.matchAll(/\/Type\s*\/Pages\b([\s\S]{0,300})/g)) {
    const count = /\/Count\s+(\d+)/.exec(m[1]);
    if (count) max = Math.max(max, Number(count[1]));
  }
  return max > 0 ? max : null;
}

export interface ImageSize {
  width: number;
  height: number;
}

const sized = (width: number, height: number): ImageSize | null => (width > 0 && height > 0 ? { width, height } : null);

function jpegSize(b: Uint8Array): ImageSize | null {
  let i = 2;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) return null;
    while (i + 1 < b.length && b[i + 1] === 0xff) i++; // fill bytes
    if (i + 1 >= b.length) return null;
    const marker = b[i + 1];
    if (marker === 0xda || marker === 0xd9) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 8 >= b.length) return null;
      return sized((b[i + 7] << 8) | b[i + 8], (b[i + 5] << 8) | b[i + 6]);
    }
    if (i + 3 >= b.length) return null;
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return null;
}

function webpSize(b: Uint8Array): ImageSize | null {
  if (startsWith(b, [0x56, 0x50, 0x38, 0x20], 12)) {
    // "VP8 "
    if (b.length < 30) return null;
    return sized((b[26] | (b[27] << 8)) & 0x3fff, (b[28] | (b[29] << 8)) & 0x3fff);
  }
  if (startsWith(b, [0x56, 0x50, 0x38, 0x4c], 12)) {
    // "VP8L"
    if (b.length < 25 || b[20] !== 0x2f) return null;
    return sized(1 + (((b[22] & 0x3f) << 8) | b[21]), 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)));
  }
  if (startsWith(b, [0x56, 0x50, 0x38, 0x58], 12)) {
    // "VP8X"
    if (b.length < 30) return null;
    return sized(1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16)));
  }
  return null;
}

/** Pixel size from the image's header alone, or null when it can't be read. */
export function imageSize(bytes: Uint8Array, mediaType: string): ImageSize | null {
  const b = bytes;
  switch (mediaType) {
    case "image/png": {
      if (b.length < 24 || !startsWith(b, [0x49, 0x48, 0x44, 0x52], 12)) return null;
      const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
      return sized(view.getUint32(16), view.getUint32(20));
    }
    case "image/gif":
      return b.length < 10 ? null : sized(b[6] | (b[7] << 8), b[8] | (b[9] << 8));
    case "image/jpeg":
      return jpegSize(b);
    case "image/webp":
      return webpSize(b);
    default:
      return null;
  }
}
