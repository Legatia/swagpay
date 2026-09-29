import { describe, expect, it } from "vitest";
import { EMPTY_SPEC, OrderSpecSchema, missingInfo, specErrors, type OrderSpec } from "../src/order-spec";

const tee = { kind: "tshirt", description: "Black tee, logo front", method: "screen", quantity: 60, colour: "black",
  sizes: { S: 10, M: 20, L: 20, XL: 10 }, printAreas: ["front"] };
const sticker = { kind: "sticker", description: "Logo sticker", method: "diecut", quantity: 500, sizeCm: { w: 5, h: 5 } };

describe("order spec", () => {
  it("parses a full spec", () => {
    expect(OrderSpecSchema.safeParse({ items: [tee, sticker], artwork: [] }).success).toBe(true);
  });

  it("rejects bad numbers and unknown sizes", () => {
    expect(OrderSpecSchema.safeParse({ items: [{ ...tee, quantity: 0 }], artwork: [] }).success).toBe(false);
    expect(OrderSpecSchema.safeParse({ items: [{ ...tee, quantity: 2.5 }], artwork: [] }).success).toBe(false);
    expect(OrderSpecSchema.safeParse({ items: [{ ...tee, sizes: { XXXL: 3 } }], artwork: [] }).success).toBe(false);
  });

  it("flags a size split that doesn't add up", () => {
    const spec = OrderSpecSchema.parse({ items: [{ ...tee, sizes: { S: 10, M: 20, L: 20 } }], artwork: [] });
    expect(specErrors(spec)).toEqual(["item 1 (tshirt): sizes add up to 50, quantity is 60"]);
  });

  it("lists what is still missing", () => {
    const spec: OrderSpec = OrderSpecSchema.parse({
      items: [{ kind: "tshirt", description: "tee", quantity: 60 }, { kind: "sticker", description: "sticker", quantity: 100 }],
      artwork: [],
    });
    expect(missingInfo(spec)).toEqual([
      "item 1 (tshirt): print method",
      "item 1 (tshirt): colour",
      "item 1 (tshirt): size split",
      "item 1 (tshirt): print area",
      "item 2 (sticker): print method",
      "item 2 (sticker): size in cm",
      "printable artwork",
    ]);
    expect(missingInfo(EMPTY_SPEC)).toEqual(["at least one item", "printable artwork"]);
  });

  it("counts artwork as done once one file is printable", () => {
    const spec = OrderSpecSchema.parse({ items: [tee, sticker], artwork: [{ fileId: "f1", printable: true, issues: [] }] });
    expect(missingInfo(spec)).toEqual([]);
  });
});
