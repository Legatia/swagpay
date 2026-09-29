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
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 0, h: 0 });
    img.src = dataUrl;
  });
}

// Browser only. SVGs are kept as data URLs and only ever drawn through <image>, never inlined.
export async function readAsset(file) {
  const problem = validateUpload(file);
  if (problem) throw new Error(problem);
  const dataUrl = await readDataUrl(file);
  const { w, h } = await naturalSize(dataUrl);
  const vector = file.type === "image/svg+xml";
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
