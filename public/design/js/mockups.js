// Mockup geometry in millimetres. The t-shirt is a flat outline 560 x 720 mm; its print areas sit
// at fixed positions. Large format and stickers are framed with an 8% margin; the roll-up adds room
// for its stand.
export const TEE = {
  viewBox: [0, 0, 560, 720],
  body: "M215 50Q280 110 345 50L430 70L540 200L470 260L450 240L450 700L110 700L110 240L90 260L20 200L130 70Z",
  neck: { front: "M215 50Q280 110 345 50", back: "M215 50Q280 72 345 50" },
  origin: { front: { x: 140, y: 150 }, back: { x: 140, y: 130 } },
};

export function mockupFor(productKey, side, area) {
  if (productKey === "tshirt") return { viewBox: [...TEE.viewBox], origin: { ...TEE.origin[side] }, kind: "tee" };
  const m = Math.round(Math.max(area.widthMm, area.heightMm) * 0.08);
  const stand = productKey === "rollup" ? Math.round(area.heightMm * 0.05) : 0;
  return { viewBox: [-m, -m, area.widthMm + 2 * m, area.heightMm + 2 * m + stand], origin: { x: 0, y: 0 }, kind: productKey };
}
