export const CITIES: Record<string, [string, string]>;
export function slug(s: string): string;
export interface ImportVendorRow {
  name: string; city: string; country: string; methods: string; email: string | null; website: string | null;
  tax_id_type: string | null; tax_id: string | null; tax_status: string | null; tax_checked_at: string | null;
  lead_days: string | null; lat: number | null; lng: number | null; status: "candidate" | "screened"; source_ref: string;
}
export function toVendorRows(cityKey: string, records: Array<Record<string, unknown>>, warn?: (m: string) => void): ImportVendorRow[];
export function upsertSql(rows: ImportVendorRow[], now?: string): string;
