// Mockup geometry in millimetres. The t-shirt is a flat outline 560 x 720 mm; its print areas sit
// at fixed positions. Large format and stickers are framed with an 8% margin; the roll-up adds room
// for its stand.
//
// The tee is drawn front-on: sloped shoulders, set-in sleeves with a hem line, a slightly curved hem
// and, on the front, the inside of the back collar showing through the neck opening.
export const TEE = {
  viewBox: [0, 0, 560, 720],
  body: "M212 48C240 64 320 64 348 48L428 70C470 96 506 134 530 178L474 240L442 208C446 360 448 520 450 690Q280 704 110 690C112 520 114 360 118 208L86 240L30 178C54 134 90 96 132 70Z",
  neck: { front: "M212 48C236 90 324 90 348 48", back: "M212 48C240 64 320 64 348 48" },
  // The inside of the back collar, seen through the front neck opening.
  collar: { front: "M212 48C240 64 320 64 348 48C324 90 236 90 212 48Z", back: null },
  // Stitch and seam lines, drawn thin and faint over the colour.
  seams: [
    "M40 168L96 230",
    "M520 168L464 230",
    "M118 208C124 150 128 104 132 70",
    "M442 208C436 150 432 104 428 70",
    "M112 676Q280 690 448 676",
  ],
  rib: { front: "M218 52C244 100 316 100 342 52", back: "M218 54C244 70 316 70 342 54" },
  origin: { front: { x: 140, y: 150 }, back: { x: 140, y: 130 } },
};

export function mockupFor(productKey, side, area) {
  if (productKey === "tshirt") return { viewBox: [...TEE.viewBox], origin: { ...TEE.origin[side] }, kind: "tee" };
  const m = Math.round(Math.max(area.widthMm, area.heightMm) * 0.08);
  const stand = productKey === "rollup" ? Math.round(area.heightMm * 0.05) : 0;
  return { viewBox: [-m, -m, area.widthMm + 2 * m, area.heightMm + 2 * m + stand], origin: { x: 0, y: 0 }, kind: productKey };
}
