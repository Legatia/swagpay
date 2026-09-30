// Turns the per-city printer research JSON into SQL for the vendors table: node scripts/vendors-import.mjs <city>-printers.json...
// The SQL never sets payout_address/payout_chain and never changes a partner or paused vendor's status.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const CITIES = { warsaw: ["Warsaw", "PL"], lisbon: ["Lisbon", "PT"], london: ["London", "GB"], mumbai: ["Mumbai", "IN"] };
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

export function toVendorRows(cityKey, records) {
  const found = CITIES[cityKey];
  if (!found) throw new Error(`unknown city "${cityKey}"`);
  const [city, country] = found;
  return records.map((r) => {
    const email = str(r.email);
    const nip = str(r.nip);
    const taxStatus = r.vat_status ?? r.tax_status;
    return {
      name: String(r.name),
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error("usage: node scripts/vendors-import.mjs <city>-printers.json...");
    process.exit(2);
  }
  const counts = {};
  const out = [];
  for (const file of files) {
    const m = basename(file).match(/^([a-z]+)-printers\.json$/);
    if (!m || !CITIES[m[1]]) {
      console.error(`can't tell the city from "${file}" (expected <city>-printers.json)`);
      process.exit(2);
    }
    const rows = toVendorRows(m[1], JSON.parse(readFileSync(file, "utf8")));
    for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
    out.push(upsertSql(rows));
  }
  console.log(out.join("\n"));
  console.error(Object.entries(counts).map(([s, n]) => `${s}: ${n}`).join(", "));
}
