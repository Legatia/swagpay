// The printers the order agent picked for a cost request: asked in the sandbox (simulated replies), drafted for the owner in production.
import { getVendor, methodsOf, vendorScore, type VendorRow } from "./vendors";

export type QuoteRequestStatus = "asked" | "replied" | "declined" | "expired" | "drafted";

export interface QuoteRequestRow {
  id: number;
  order_id: number;
  escalation_id: number;
  vendor_id: number;
  status: QuoteRequestStatus;
  offer_id: number | null;
  decline_reason: string | null;
  notified_at: string | null;
  created_at: string;
  settled_at: string | null;
}

export type QuoteRequestView = QuoteRequestRow & { vendor: VendorRow | null };

export const MAX_ASKED_PER_COST_REQUEST = 6;

/**
 * Why these printers can't be asked: unknown, not verified, paused, listed twice, already asked for this cost request,
 * or more than 6 in total. Empty when all can. `escalationId` null checks the printers only.
 */
export async function askRefusals(db: D1Database, escalationId: number | null, vendorIds: number[]): Promise<string[]> {
  const asked = escalationId === null
    ? []
    : (await db.prepare("SELECT vendor_id FROM quote_requests WHERE escalation_id = ?").bind(escalationId).all<{ vendor_id: number }>()).results.map((r) => r.vendor_id);
  const refused: string[] = [];
  const seen = new Set<number>();
  for (const id of vendorIds) {
    if (seen.has(id)) {
      refused.push(`printer #${id} is listed twice`);
      continue;
    }
    seen.add(id);
    const v = await getVendor(db, id);
    if (!v) refused.push(`printer #${id} doesn't exist`);
    else if (v.status === "paused") refused.push(`printer #${id} is paused`);
    else if (v.status !== "screened" && v.status !== "partner") refused.push(`printer #${id} isn't verified`);
    else if (asked.includes(id)) refused.push(`printer #${id} was already asked for this cost request`);
  }
  if (!refused.length && asked.length + seen.size > MAX_ASKED_PER_COST_REQUEST) {
    refused.push(`at most ${MAX_ASKED_PER_COST_REQUEST} printers per cost request (${asked.length} already asked)`);
  }
  return refused;
}

/** Records the printers asked for one cost request; nothing is written when any of them is refused. */
export async function recordAsked(
  db: D1Database, p: { orderId: number; escalationId: number; vendorIds: number[]; status: "asked" | "drafted" }, now: Date = new Date(),
): Promise<{ rows: QuoteRequestRow[]; refused: string[] }> {
  const refused = await askRefusals(db, p.escalationId, p.vendorIds);
  if (refused.length || !p.vendorIds.length) return { rows: [], refused };
  const at = now.toISOString();
  const results = await db.batch(p.vendorIds.map((vendorId) =>
    db.prepare("INSERT INTO quote_requests (order_id, escalation_id, vendor_id, status, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *")
      .bind(p.orderId, p.escalationId, vendorId, p.status, at)));
  return { rows: results.map((r) => (r.results as QuoteRequestRow[])[0]), refused: [] };
}

async function withVendors(db: D1Database, rows: QuoteRequestRow[]): Promise<QuoteRequestView[]> {
  return Promise.all(rows.map(async (r) => ({ ...r, vendor: await getVendor(db, r.vendor_id) })));
}

export async function quoteRequestsFor(db: D1Database, escalationId: number): Promise<QuoteRequestView[]> {
  return withVendors(db, (await db.prepare("SELECT * FROM quote_requests WHERE escalation_id = ? ORDER BY id").bind(escalationId).all<QuoteRequestRow>()).results);
}

export async function quoteRequestsForOrder(db: D1Database, orderId: number): Promise<QuoteRequestView[]> {
  return withVendors(db, (await db.prepare("SELECT * FROM quote_requests WHERE order_id = ? ORDER BY id").bind(orderId).all<QuoteRequestRow>()).results);
}

/** The owner's lines for the agent's picks (for the cost request), or why they can't be asked; writes nothing. */
export async function pickedPrinterLines(db: D1Database, vendorIds: number[]): Promise<{ lines: string[]; refused: string[] }> {
  const refused = await askRefusals(db, null, vendorIds);
  if (refused.length) return { lines: [], refused };
  const lines: string[] = [];
  for (const id of vendorIds) {
    const v = (await getVendor(db, id))!;
    const s = await vendorScore(db, id);
    const name = v.name.replace(/\s+/g, " ").trim().slice(0, 40);
    lines.push(`v${v.id} ${name} (${v.city}; ${methodsOf(v).join(", ") || "methods unknown"}; ${s.jobs} jobs, ${s.onTime} on time${v.found_by === "agent" ? "; found by the agent" : ""})`);
  }
  return { lines, refused: [] };
}
