// Upload checks match the order API's limits for the files we accept in the editor.
export const MAX_UPLOAD_BYTES = 10_000_000;
export const UPLOAD_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];

export function validateUpload({ type, size }) {
  if (!UPLOAD_TYPES.includes(type)) return "Upload a PNG, JPEG, WebP or SVG file.";
  if (size > MAX_UPLOAD_BYTES) return "Files can be up to 10 MB.";
  return null;
}

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });
}

function naturalSize(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ ok: true, w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ ok: false });
    img.src = dataUrl;
  });
}

// The aspect ratio (width / height) an SVG declares, from its viewBox or else its numeric width and
// height. Illustrator's responsive export has only a viewBox, so the browser gives it no natural size.
export function svgAspect(text) {
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (!tag) return null;
  const attr = (name) => new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag.slice(4));
  const vb = attr("viewBox");
  if (vb) {
    const n = (vb[1] ?? vb[2]).trim().split(/[\s,]+/).map(Number);
    if (n.length === 4 && n.every(Number.isFinite) && n[2] > 0 && n[3] > 0) return n[2] / n[3];
  }
  const num = (m) => (m ? Number.parseFloat(/^\s*([0-9.]+)(?:px)?\s*$/i.exec(m[1] ?? m[2])?.[1]) : NaN);
  const w = num(attr("width"));
  const h = num(attr("height"));
  return w > 0 && h > 0 ? w / h : null;
}

function dataUrlText(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const body = dataUrl.slice(comma + 1);
  try {
    return dataUrl.slice(0, comma).includes(";base64") ? atob(body) : decodeURIComponent(body);
  } catch {
    return "";
  }
}

// Browser only. SVGs are kept as data URLs and only ever drawn through <image>, never inlined.
export async function readAsset(file) {
  const problem = validateUpload(file);
  if (problem) throw new Error(problem);
  const dataUrl = await readDataUrl(file);
  const result = await naturalSize(dataUrl);
  const vector = file.type === "image/svg+xml";
  if (!result.ok) throw new Error("That file could not be opened. Try a PNG, JPEG or SVG.");
  let { w, h } = result;
  if (vector) {
    // Give a viewBox-only SVG the shape it declares, so it isn't squashed to a square.
    const aspect = svgAspect(dataUrlText(dataUrl));
    if (aspect) {
      w = 1000;
      h = Math.max(1, Math.round(1000 / aspect));
    }
  }
  if (!vector && (!w || !h)) throw new Error("That image could not be opened. Try a PNG or JPEG.");
  return {
    name: file.name.slice(0, 80),
    type: file.type,
    dataUrl,
    pixelWidth: w || 1000,
    pixelHeight: h || 1000,
    vector,
    hasAlpha: file.type !== "image/jpeg",
  };
}
