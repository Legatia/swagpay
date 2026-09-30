// Pure functions (no node:fs). Turns the per-city printer research JSON into SQL for the vendors table:
// The SQL never sets payout_address/payout_chain and never changes a partner or paused vendor's status.

export const CITIES = { warsaw: ["Warsaw", "PL"], lisbon: ["Lisbon", "PT"], london: ["London", "GB"], mumbai: ["Mumbai", "IN"] };
const METHODS = new Set(["screen", "dtf", "dtg", "diecut", "banner"]);

export function slug(s) {
  return String(s).toLowerCase().replace(/ł/g, "l").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

function screened(r, email) {
  if (!email) return false;
  if (r.vat_status === "active") return true;
  if (r.tax_status === true || (typeof r.tax_status === "string" && r.tax_status.trim().toLowerCase() === "valid")) return true;
  return Boolean(str(r.company_number)) && String(r.company_status).toLowerCase() === "active";
}

export function toVendorRows(cityKey, records, warn = () => {}) {
  const found = CITIES[cityKey];
  if (!found) throw new Error(`unknown city "${cityKey}"`);
  const [city, country] = found;
  const seen = new Set();
  const out = [];
  for (const r of records) {
    if (!str(r?.name)) {
      warn(`${cityKey}: skipped a record without a name`);
      continue;
    }
    const ref = `${cityKey}:${slug(r.name)}`;
    if (seen.has(ref)) {
      warn(`${cityKey}: skipped "${r.name}", duplicate of ${ref}`);
      continue;
    }
    seen.add(ref);
    out.push(r);
  }
  return out.map((r) => {
    const email = str(r.email);
    const nip = str(r.nip);
    const taxStatus = r.vat_status ?? r.tax_status;
    return {
      name: r.name.trim(),
      city,
      country,
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
      source_ref: `${cityKey}:${slug(r.name)}`,
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

