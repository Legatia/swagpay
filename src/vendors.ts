export type VendorStatus = "candidate" | "screened" | "partner" | "paused";

export interface VendorRow {
  id: number;
  name: string;
  city: string;
  country: string;
  /** JSON array of method names. */
  methods: string;
  email: string | null;
  website: string | null;
  tax_id_type: string | null;
  tax_id: string | null;
  tax_status: string | null;
  tax_checked_at: string | null;
  /** JSON object, or null. */
  lead_days: string | null;
  lat: number | null;
  lng: number | null;
  status: VendorStatus;
  payout_address: string | null;
  payout_chain: string | null;
  pay_currency: string | null;
  how_to_pay: string | null;
  source_ref: string;
  created_at: string;
  updated_at: string;
}

export interface VendorJobRow {
  id: number;
  order_id: number;
  vendor_id: number;
  status: "proposed" | "booked" | "printed" | "delivered";
  cost_currency: string;
  cost_cents: number;
  deliver_by: string;
  booked_at: string | null;
  printed_at: string | null;
  delivered_at: string | null;
  on_time: number | null;
  created_at: string;
}

const CITY_ALIASES: Array<[string, string[]]> = [
  ["Warsaw", ["warsaw", "warszawa", "warszawie"]],
  ["Lisbon", ["lisbon", "lisboa"]],
  ["London", ["london"]],
  ["Mumbai", ["mumbai", "bombay", "bkc"]],
];

function matchCity(text: string): string | null {
  const words = new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u));
  for (const [city, aliases] of CITY_ALIASES) if (aliases.some((a) => words.has(a))) return city;
  return null;
}

/** The vendor city a delivery place is in: the last comma-separated segment first (the city usually ends an address), then the whole string. Names and aliases match case-insensitively on word boundaries. */
export function cityFromPlace(place: string): string | null {
  const last = place.split(",").pop() ?? "";
  return matchCity(last) ?? matchCity(place);
}

export async function getVendor(db: D1Database, id: number): Promise<VendorRow | null> {
  return db.prepare("SELECT * FROM vendors WHERE id = ?").bind(id).first<VendorRow>();
}

export async function listVendors(db: D1Database, f: { city?: string; statuses?: VendorStatus[]; limit?: number } = {}): Promise<VendorRow[]> {
  const where: string[] = [];
  const binds: Array<string | number> = [];
  if (f.city) { where.push("city = ?"); binds.push(f.city); }
  if (f.statuses?.length) { where.push(`status IN (${f.statuses.map(() => "?").join(", ")})`); binds.push(...f.statuses); }
  return (await db
    .prepare(`SELECT * FROM vendors ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY name, id LIMIT ?`)
    .bind(...binds, f.limit ?? 100)
    .all<VendorRow>()).results;
}

export async function setVendorStatus(db: D1Database, id: number, status: VendorStatus, now: Date = new Date()): Promise<boolean> {
  // Leaving partner drops the registered payout, so a re-promoted printer must register its address again.
  const res = await db
    .prepare(
      `UPDATE vendors SET status = ?1, updated_at = ?2,
         payout_address = CASE WHEN ?1 = 'partner' THEN payout_address ELSE NULL END,
         payout_chain = CASE WHEN ?1 = 'partner' THEN payout_chain ELSE NULL END
       WHERE id = ?3`,
    )
    .bind(status, now.toISOString(), id)
    .run();
  return res.meta.changes === 1;
}

/** Registers where a vendor is paid; only a partner may have one. */
export async function setVendorPayout(
  db: D1Database, id: number, address: string, chain: string, now: Date = new Date(),
): Promise<"ok" | "not_partner" | "missing"> {
  const res = await db
    .prepare("UPDATE vendors SET payout_address = ?, payout_chain = ?, updated_at = ? WHERE id = ? AND status = 'partner'")
    .bind(address, chain, now.toISOString(), id)
    .run();
  if (res.meta.changes === 1) return "ok";
  return (await getVendor(db, id)) ? "not_partner" : "missing";
}

/** Closed jobs (delivered) and how many of them were on time. */
export async function vendorScore(db: D1Database, id: number): Promise<{ jobs: number; onTime: number }> {
  const r = await db
    .prepare("SELECT COUNT(*) AS jobs, COALESCE(SUM(on_time), 0) AS onTime FROM vendor_jobs WHERE vendor_id = ? AND delivered_at IS NOT NULL")
    .bind(id)
    .first<{ jobs: number; onTime: number }>();
  return { jobs: r?.jobs ?? 0, onTime: r?.onTime ?? 0 };
}

function methodsOf(v: VendorRow): string[] {
  try {
    const m: unknown = JSON.parse(v.methods);
    return Array.isArray(m) ? m.map(String) : [];
  } catch {
    return [];
  }
}

/** Partner and screened vendors in a city, best first: partner, then covering every method, then on-time jobs, then name. */
export async function suggestVendors(
  db: D1Database, city: string, methods: string[], limit = 3,
): Promise<Array<{ vendor: VendorRow; covers: boolean; score: { jobs: number; onTime: number } }>> {
  const vendors = (await db
    .prepare("SELECT * FROM vendors WHERE city = ? AND status IN ('partner', 'screened')")
    .bind(city)
    .all<VendorRow>()).results;
  const ranked = await Promise.all(vendors.map(async (vendor) => {
    const have = new Set(methodsOf(vendor));
    return { vendor, covers: methods.every((m) => have.has(m)), score: await vendorScore(db, vendor.id) };
  }));
  ranked.sort((a, b) =>
    Number(b.vendor.status === "partner") - Number(a.vendor.status === "partner")
    || Number(b.covers) - Number(a.covers)
    || b.score.onTime - a.score.onTime
    || a.vendor.name.localeCompare(b.vendor.name));
  return ranked.slice(0, limit);
}

/** One job per order. A new proposal replaces the vendor and cost while the job is `proposed`; null once it has moved on. */
export async function proposeVendorJob(
  db: D1Database, p: { orderId: number; vendorId: number; deliverBy: string; currency: string; cents: number }, now: Date = new Date(),
): Promise<VendorJobRow | null> {
  await db
    .prepare(
      `INSERT INTO vendor_jobs (order_id, vendor_id, status, cost_currency, cost_cents, deliver_by, created_at)
       VALUES (?, ?, 'proposed', ?, ?, ?, ?)
       ON CONFLICT(order_id) DO UPDATE SET vendor_id = excluded.vendor_id, cost_currency = excluded.cost_currency,
         cost_cents = excluded.cost_cents, deliver_by = excluded.deliver_by
       WHERE vendor_jobs.status = 'proposed'`,
    )
    .bind(p.orderId, p.vendorId, p.currency, p.cents, p.deliverBy, now.toISOString())
    .run();
  const row = await vendorJobFor(db, p.orderId);
  return row && row.status === "proposed" ? row : null;
}

export async function vendorJobFor(db: D1Database, orderId: number): Promise<VendorJobRow | null> {
  return db.prepare("SELECT * FROM vendor_jobs WHERE order_id = ?").bind(orderId).first<VendorJobRow>();
}

const FROM: Record<"booked" | "printed" | "delivered", string[]> = {
  booked: ["proposed"],
  printed: ["booked"],
  delivered: ["booked", "printed"],
};

/** Moves a job forward one step; returns the row, or null when the order has no job or it can't move that way. `delivered` sets on_time. */
export async function markJob(
  db: D1Database, orderId: number, to: "booked" | "printed" | "delivered", now: Date = new Date(),
): Promise<VendorJobRow | null> {
  const at = now.toISOString();
  const from = FROM[to];
  const inList = from.map(() => "?").join(", ");
  if (to === "delivered") {
    // Both are toISOString() output (UTC), so text order is time order.
    await db
      .prepare(`UPDATE vendor_jobs SET status = 'delivered', delivered_at = ?1, on_time = CASE WHEN ?1 <= deliver_by THEN 1 ELSE 0 END WHERE order_id = ?2 AND status IN (${from.map((_, i) => `?${i + 3}`).join(", ")})`)
      .bind(at, orderId, ...from)
      .run();
  } else {
    await db
      .prepare(`UPDATE vendor_jobs SET status = ?, ${to}_at = ? WHERE order_id = ? AND status IN (${inList})`)
      .bind(to, at, orderId, ...from)
      .run();
  }
  const row = await vendorJobFor(db, orderId);
  return row && row.status === to ? row : null;
}
export async function setVendorPayDetails(db: D1Database, id: number, d: { payCurrency: string; howToPay: string | null }, now: Date = new Date()): Promise<VendorRow | null> {
  return db.prepare("UPDATE vendors SET pay_currency = ?, how_to_pay = ?, updated_at = ? WHERE id = ? RETURNING *").bind(d.payCurrency, d.howToPay, now.toISOString(), id).first<VendorRow>();
}
