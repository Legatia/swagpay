// Pure functions (no node:fs). Turns the per-city printer research JSON into SQL for the vendors table:
// The SQL never sets payout_address/payout_chain and never changes a partner or paused vendor's status.

export const CITIES = { warsaw: ["Warsaw", "PL"], lisbon: ["Lisbon", "PT"], london: ["London", "GB"], mumbai: ["Mumbai", "IN"] };
const METHODS = new Set(["screen", "dtf", "dtg", "diecut", "banner"]);

export function slug(s) {
  return String(s).toLowerCase().replace(/ł/g, "l").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** A VAT check that passed: `true`, or text that starts with "valid" (the research records "valid: true; VIES name: …") and never says false or invalid. */
function taxValid(status) {
  if (status === true) return true;
  if (typeof status !== "string") return false;
  const s = status.trim();
  return /^valid\b/i.test(s) && !/\bfalse\b|\binvalid\b/i.test(s);
}

function screened(r, email) {
  if (!email) return false;
  if (r.vat_status === "active") return true;
  if (taxValid(r.tax_status)) return true;
  return Boolean(str(r.company_number)) && String(r.company_status).toLowerCase() === "active";
}

/** cityKey is one of CITIES, or "far": printers elsewhere, each record carrying its own city and ISO-2 country. */
export function toVendorRows(cityKey, records, warn = () => {}) {
  const far = cityKey === "far";
  const found = CITIES[cityKey];
  if (!far && !found) throw new Error(`unknown city "${cityKey}"`);
  const seen = new Set();
  const out = [];
  for (const r of records) {
    if (!str(r?.name)) {
      warn(`${cityKey}: skipped a record without a name`);
      continue;
    }
    if (far && (!str(r.city) || !/^[A-Z]{2}$/.test(String(r.country ?? "")))) {
      warn(`far: skipped "${r.name}", it has no city or no ISO-2 country`);
      continue;
    }
    const ref = far ? `far:${slug(r.city)}:${slug(r.name)}` : `${cityKey}:${slug(r.name)}`;
    if (seen.has(ref)) {
      warn(`${cityKey}: skipped "${r.name}", duplicate of ${ref}`);
      continue;
    }
    seen.add(ref);
    out.push([r, ref]);
  }
  return out.map(([r, ref]) => {
    const email = str(r.email);
    const nip = str(r.nip);
    const taxStatus = r.vat_status ?? r.tax_status;
    return {
      name: r.name.trim(),
      city: far ? r.city.trim() : found[0],
      country: far ? r.country : found[1],
      methods: JSON.stringify((Array.isArray(r.methods) ? r.methods : []).filter((m) => METHODS.has(m))),
      email,
      website: str(r.website),
      tax_id_type: nip ? "NIP" : str(r.tax_id_type),
      tax_id: nip ?? str(r.tax_id),
      tax_status: taxStatus === null || taxStatus === undefined ? null : String(taxStatus),
      tax_checked_at: str(r.vat_checked_at) ?? str(r.tax_checked_at),
      lead_days: r.lead_days && typeof r.lead_days === "object" ? JSON.stringify(r.lead_days) : null,
      lat: typeof r.lat === "number" ? r.lat : null,
      lng: typeof r.lng === "number" ? r.lng : null,
      status: screened(r, email) ? "screened" : "candidate",
      source_ref: ref,
    };
  });
}

const lit = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`);

export function upsertSql(rows, now = new Date().toISOString()) {
  return rows
    .map((r) => `INSERT INTO vendors (name, city, country, methods, email, website, tax_id_type, tax_id, tax_status, tax_checked_at, lead_days, lat, lng, status, source_ref, created_at, updated_at)
VALUES (${[r.name, r.city, r.country, r.methods, r.email, r.website, r.tax_id_type, r.tax_id, r.tax_status, r.tax_checked_at, r.lead_days, r.lat, r.lng, r.status, r.source_ref, now, now].map(lit).join(", ")})
ON CONFLICT(source_ref) DO UPDATE SET
  name = excluded.name, methods = excluded.methods, email = excluded.email, website = excluded.website,
  tax_id_type = excluded.tax_id_type, tax_id = excluded.tax_id, tax_status = excluded.tax_status, tax_checked_at = excluded.tax_checked_at,
  lead_days = excluded.lead_days, lat = excluded.lat, lng = excluded.lng, updated_at = excluded.updated_at,
  status = CASE WHEN vendors.status IN ('partner', 'paused') THEN vendors.status ELSE excluded.status END;`)
    .join("\n");
}

