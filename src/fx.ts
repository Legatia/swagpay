import type { Currency } from "./money";

export const NBP_BASE = "https://api.nbp.pl/api/exchangerates/rates/a";
/** NBP publishes once a business day; the hourly refresh keeps fetched_at recent while NBP is up. */
export const RATE_MAX_AGE_HOURS = 6;

export async function fetchNbpRate(code: Currency, fetchImpl: typeof fetch = fetch): Promise<{ plnPerUnit: number; effectiveDate: string }> {
  const res = await fetchImpl(`${NBP_BASE}/${code.toLowerCase()}/?format=json`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`NBP ${code}: HTTP ${res.status}`);
  const body = (await res.json()) as { rates?: { mid?: unknown; effectiveDate?: unknown }[] };
  const rate = body.rates?.[0];
  const mid = Number(rate?.mid);
  if (!(mid > 0) || typeof rate?.effectiveDate !== "string") throw new Error(`NBP ${code}: unexpected response`);
  return { plnPerUnit: mid, effectiveDate: rate.effectiveDate };
}

export async function refreshRates(db: D1Database, fetchImpl: typeof fetch = fetch, now: Date = new Date()): Promise<void> {
  const [usd, eur] = await Promise.all([fetchNbpRate("USD", fetchImpl), fetchNbpRate("EUR", fetchImpl)]);
  const upsert = db.prepare(
    `INSERT INTO fx_rates (code, pln_per_unit, effective_date, fetched_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET pln_per_unit = excluded.pln_per_unit, effective_date = excluded.effective_date, fetched_at = excluded.fetched_at`,
  );
  await db.batch([
    upsert.bind("USD", usd.plnPerUnit, usd.effectiveDate, now.toISOString()),
    upsert.bind("EUR", eur.plnPerUnit, eur.effectiveDate, now.toISOString()),
  ]);
}

export interface Rates {
  /** PLN per 1 unit of the quote currency. */
  plnPerUnit: number;
  /** USD per 1 unit of the quote currency. */
  usdPerUnit: number;
}

/** Rates for quoting in `currency`, or null when a needed rate is missing or older than RATE_MAX_AGE_HOURS. */
export async function ratesFor(db: D1Database, currency: Currency, now: Date = new Date()): Promise<Rates | null> {
  const rows = (await db.prepare("SELECT code, pln_per_unit, fetched_at FROM fx_rates").all<{ code: string; pln_per_unit: number; fetched_at: string }>()).results;
  const fresh = (code: Currency): number | null => {
    const r = rows.find((x) => x.code === code);
    return r && now.getTime() - Date.parse(r.fetched_at) <= RATE_MAX_AGE_HOURS * 3_600_000 ? r.pln_per_unit : null;
  };
  const usd = fresh("USD");
  if (usd === null) return null;
  if (currency === "USD") return { plnPerUnit: usd, usdPerUnit: 1 };
  const eur = fresh("EUR");
  return eur === null ? null : { plnPerUnit: eur, usdPerUnit: eur / usd };
}
