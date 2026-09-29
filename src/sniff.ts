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
