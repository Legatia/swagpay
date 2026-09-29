import { z } from "zod";
import { sanitize } from "./agent/inbox";
import { SIZES } from "./order-spec";

export const MAX_DESIGN_BYTES = 65_536;

const Mm = z.number().finite().min(-10_000).max(10_000);
const Size = z.number().finite().positive().max(10_000);
const Rotation = z.number().finite().min(-360).max(360);

const ImageLayer = z.object({
  type: z.literal("image"), file: z.string().min(1).max(40),
  xMm: Mm, yMm: Mm, widthMm: Size, heightMm: Size, rotationDeg: Rotation,
  effectiveDpi: z.number().finite().nonnegative().max(100_000).optional(),
});

const TextLayer = z.object({
  type: z.literal("text"), text: z.string().min(1).max(200), font: z.string().min(1).max(60),
  weight: z.number().int().min(100).max(1000), colour: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  sizeMm: Size, xMm: Mm, yMm: Mm, widthMm: Size, rotationDeg: Rotation, align: z.enum(["left", "center", "right"]),
});

const View = z.object({
  side: z.string().min(1).max(20),
  printArea: z.object({ widthMm: Size, heightMm: Size }),
  layers: z.array(z.discriminatedUnion("type", [ImageLayer, TextLayer])).max(20),
});

export const DesignSpecSchema = z.object({
  version: z.literal(1),
  product: z.enum(["tshirt", "sticker", "banner", "rollup", "flag"]),
  options: z.record(z.string().min(1).max(40), z.string().max(60)).optional(),
  views: z.array(View).min(1).max(4),
  sizes: z.partialRecord(z.enum(SIZES), z.number().int().min(0).max(5000)).nullable().optional(),
  quantity: z.number().int().min(1).max(5000),
  sticker: z.object({
    longestSideMm: Size, shape: z.enum(["contour", "circle", "rounded-square"]), borderMm: z.number().finite().min(0).max(20),
  }).nullable(),
  estimate: z.object({ currency: z.enum(["USD", "EUR"]), low: z.number().finite().nonnegative(), high: z.number().finite().nonnegative() }).nullable().optional(),
  files: z.record(z.string().min(1).max(40), z.object({ role: z.enum(["artwork", "mockup", "print", "cutline"]), fileId: z.uuid() }))
    .refine((f) => Object.keys(f).length <= 10, "at most 10 files"),
});

export type DesignSpec = z.infer<typeof DesignSpecSchema>;

/** File references that don't resolve to this order's uploads, or image layers pointing at no file. */
export function designProblems(design: DesignSpec, uploads: { fileId: string; role: string }[]): string[] {
  const problems: string[] = [];
  const ids = new Set(uploads.map((u) => u.fileId));
  for (const [key, f] of Object.entries(design.files)) {
    if (!ids.has(f.fileId)) problems.push(`files[${JSON.stringify(key)}]: no upload with fileId ${f.fileId} on this order`);
  }
  for (const view of design.views) {
    for (const layer of view.layers) {
      if (layer.type === "image" && !Object.hasOwn(design.files, layer.file)) problems.push(`layer file ${JSON.stringify(layer.file)} is not in files`);
    }
  }
  return problems;
}

const q = (s: string) => JSON.stringify(sanitize(s));

/** A compact description for the agent; every host-chosen string is quoted and sanitised. */
export function designSummary(d: DesignSpec): string {
  const lines = [`Design from the Swagpay editor: ${d.quantity} × ${d.product}.`];
  if (d.options && Object.keys(d.options).length) lines.push(`options (from the host): ${sanitize(JSON.stringify(d.options))}`);
  if (d.sizes) lines.push(`sizes ${Object.entries(d.sizes).filter(([, n]) => n).map(([s, n]) => `${s} ${n}`).join(", ")}`);
  if (d.sticker) lines.push(`sticker: longest side ${d.sticker.longestSideMm} mm, ${d.sticker.shape}, ${d.sticker.borderMm} mm border`);
  for (const v of d.views) {
    lines.push(`view ${q(v.side)} (print area ${v.printArea.widthMm} × ${v.printArea.heightMm} mm):`);
    for (const l of v.layers) {
      if (l.type === "image") {
        const f = d.files[l.file];
        lines.push(`- image ${q(l.file)} (fileId ${f?.fileId ?? "?"}, ${f?.role ?? "?"}) ${l.widthMm} × ${l.heightMm} mm${l.effectiveDpi !== undefined ? ` at ${l.effectiveDpi} dpi` : ""}`);
      } else {
        lines.push(`- text (from the host) ${q(l.text)} in font ${q(l.font)} ${l.weight}, ${l.sizeMm} mm, ${l.colour}`);
      }
    }
  }
  const other = Object.entries(d.files).filter(([, f]) => f.role !== "artwork").map(([k, f]) => `${q(k)} ${f.role} (fileId ${f.fileId})`);
  if (other.length) lines.push(`other files: ${other.join("; ")}`);
  if (d.estimate) lines.push(`host's estimate ${d.estimate.low}–${d.estimate.high} ${d.estimate.currency} (from the editor, not a quote)`);
  return lines.join("\n");
}
