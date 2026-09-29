// The editor's products. Numbers match the design editor spec and the order policy.
export const SIZE_KEYS = ["XS", "S", "M", "L", "XL", "XXL", "3XL"];
export const OWNER_NOTE = "Needs the owner's confirmation before the agent quotes it.";

export const PRODUCTS = {
  tshirt: {
    key: "tshirt",
    name: "T-shirt",
    blurb: "Front and back print, four colours, sizes XS–3XL.",
    views: [
      { side: "front", widthMm: 280, heightMm: 380 },
      { side: "back", widthMm: 280, heightMm: 380 },
    ],
    colours: [
      { key: "white", label: "White", hex: "#ffffff" },
      { key: "black", label: "Black", hex: "#1c1c1f" },
      { key: "navy", label: "Navy", hex: "#1f2a44" },
      { key: "heather-grey", label: "Heather grey", hex: "#b9bbbf" },
    ],
    dpi: { warn: 150, block: 100 },
    needsOwner: false,
  },
  sticker: {
    key: "sticker",
    name: "Die-cut sticker",
    blurb: "Cut to your logo's shape, with a white border.",
    sizes: [50, 75, 100],
    borderMm: 3,
    shapes: [
      { key: "contour", label: "Follow the logo" },
      { key: "circle", label: "Circle" },
      { key: "rounded-square", label: "Rounded square" },
    ],
    dpi: { warn: 300, block: 200 },
    needsOwner: false,
  },
  banner: {
    key: "banner",
    name: "Banner",
    blurb: "One-sided banner for walls and stages.",
    presets: [
      { key: "200x100", label: "200 × 100 cm", widthMm: 2000, heightMm: 1000 },
      { key: "300x100", label: "300 × 100 cm", widthMm: 3000, heightMm: 1000 },
    ],
    dpi: { warn: 100, block: 60 },
    needsOwner: true,
  },
  rollup: {
    key: "rollup",
    name: "Roll-up",
    blurb: "Roll-up stand with your print, for entrances and booths.",
    presets: [{ key: "85x200", label: "85 × 200 cm", widthMm: 850, heightMm: 2000 }],
    dpi: { warn: 100, block: 60 },
    needsOwner: true,
  },
  flag: {
    key: "flag",
    name: "Flag",
    blurb: "A flag for walls or poles.",
    presets: [{ key: "100x150", label: "100 × 150 cm", widthMm: 1000, heightMm: 1500 }],
    dpi: { warn: 100, block: 60 },
    needsOwner: true,
  },
};

function product(key) {
  const p = PRODUCTS[key];
  if (!p) throw new Error(`unknown product: ${key}`);
  return p;
}

export function viewAreas(productKey, options = {}, sticker = {}) {
  const p = product(productKey);
  if (p.views) return p.views.map((v) => ({ ...v }));
  if (p.sizes) {
    const longest = sticker.longestSideMm ?? p.sizes[1];
    const a = longest - 2 * p.borderMm;
    return [{ side: "front", widthMm: a, heightMm: a }];
  }
  const preset = p.presets.find((x) => x.key === options.size) ?? p.presets[0];
  return [{ side: "front", widthMm: preset.widthMm, heightMm: preset.heightMm }];
}

export function defaultOptions(productKey) {
  const p = product(productKey);
  if (p.colours) return { colour: "black" };
  if (p.presets) return { size: p.presets[0].key };
  return {};
}

function num(mm) {
  return (mm / 10).toFixed(1).replace(/\.0$/, "");
}

export function cm(mm) {
  return `${num(mm)} cm`;
}

export function dims(wMm, hMm) {
  return `${num(wMm)} × ${num(hMm)} cm`;
}
