import { z } from "zod";

export const SIZES = ["XS", "S", "M", "L", "XL", "XXL", "3XL"] as const;

export const ItemSchema = z.object({
  kind: z.string().min(1).max(40).describe('"tshirt" or "sticker"; anything else needs the owner\'s approval'),
  description: z.string().min(1).max(500).describe("What the host wants, in a few words"),
  method: z.string().max(20).optional().describe('tshirt: "screen", "dtf" or "dtg"; sticker: "diecut"'),
  quantity: z.number().int().min(1).max(5000),
  colour: z.string().max(40).optional().describe("Garment colour for t-shirts"),
  sizes: z.partialRecord(z.enum(SIZES), z.number().int().min(0).max(5000)).optional()
    .describe("T-shirt size split; must add up to quantity"),
  printAreas: z.array(z.string().max(40)).max(6).optional().describe('For t-shirts, e.g. ["front", "back"]'),
  sizeCm: z.object({ w: z.number().positive().max(200), h: z.number().positive().max(200) }).optional()
    .describe("Sticker size in centimetres"),
});

export const ArtworkReviewSchema = z.object({
  fileId: z.string().min(1).max(64),
  printable: z.boolean(),
  issues: z.array(z.string().max(300)).max(10),
});

export const OrderSpecSchema = z.object({
  items: z.array(ItemSchema).max(10),
  artwork: z.array(ArtworkReviewSchema).max(20),
  notes: z.string().max(2000).optional(),
});

export type OrderSpec = z.infer<typeof OrderSpecSchema>;

export const EMPTY_SPEC: OrderSpec = { items: [], artwork: [] };

const label = (i: number, kind: string) => `item ${i + 1} (${kind})`;

/** Contradictions that make a spec unusable. */
export function specErrors(spec: OrderSpec): string[] {
  const errors: string[] = [];
  spec.items.forEach((item, i) => {
    if (item.sizes) {
      const total = Object.values(item.sizes).reduce((a, b) => a + (b ?? 0), 0);
      if (total !== item.quantity) errors.push(`${label(i, item.kind)}: sizes add up to ${total}, quantity is ${item.quantity}`);
    }
  });
  return errors;
}

/** What the agent still has to find out before the order can be quoted. */
export function missingInfo(spec: OrderSpec): string[] {
  const missing: string[] = [];
  if (spec.items.length === 0) missing.push("at least one item");
  spec.items.forEach((item, i) => {
    const l = label(i, item.kind);
    if (!item.method) missing.push(`${l}: print method`);
    if (item.kind === "tshirt") {
      if (!item.colour) missing.push(`${l}: colour`);
      if (!item.sizes) missing.push(`${l}: size split`);
      if (!item.printAreas?.length) missing.push(`${l}: print area`);
    }
    if (item.kind === "sticker" && !item.sizeCm) missing.push(`${l}: size in cm`);
  });
  if (!spec.artwork.some((a) => a.printable)) missing.push("printable artwork");
  return missing;
}
