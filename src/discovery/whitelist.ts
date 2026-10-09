// The Polish VAT whitelist (Wykaz podatników VAT, Ministry of Finance): free, keyless, 100 searches a day per IP, 30 NIPs per search.
import { cityFromAddress } from "./names";
import type { FetchLike } from "./page";

export const WHITELIST_SEARCH = "https://wl-api.mf.gov.pl/api/search/nips";
const REGISTERED = new Set(["Czynny", "Zwolniony"]);

export interface Registration {
  nip: string;
  name: string;
  /** "Czynny" (active VAT payer) or "Zwolniony" (VAT-exempt). */
  status: string;
  /** From the working address, else the residence address; never the street. */
  city: string | null;
  accounts: string[];
}

export type WhitelistAnswer = { ok: true; found: Map<string, Registration> } | { ok: false; error: string };

/** Registered subjects by NIP; other statuses and empty entries are left out. */
export function parseWhitelist(json: unknown): Map<string, Registration> {
  const out = new Map<string, Registration>();
  const entries = (json as { result?: { entries?: unknown } } | null)?.result?.entries;
  if (!Array.isArray(entries)) return out;
  for (const e of entries) {
    const subjects = (e as { subjects?: unknown } | null)?.subjects;
    if (!Array.isArray(subjects)) continue;
    for (const s of subjects as Array<Record<string, unknown>>) {
      const nip = typeof s.nip === "string" ? s.nip : "";
      const status = typeof s.statusVat === "string" ? s.statusVat : "";
      if (!nip || !REGISTERED.has(status) || out.has(nip)) continue;
      const address = typeof s.workingAddress === "string" ? s.workingAddress : typeof s.residenceAddress === "string" ? s.residenceAddress : null;
      out.set(nip, {
        nip,
        name: typeof s.name === "string" ? s.name : "",
        status,
        city: cityFromAddress(address),
        accounts: Array.isArray(s.accountNumbers) ? s.accountNumbers.filter((a): a is string => typeof a === "string").slice(0, 5) : [],
      });
    }
  }
  return out;
}

/** One search for up to 30 distinct NIPs on `date` (YYYY-MM-DD). Any failure (a limit, an outage) is `ok: false`. */
export async function checkWhitelist(nips: string[], date: string, fetchImpl: FetchLike): Promise<WhitelistAnswer> {
  const list = [...new Set(nips)].slice(0, 30);
  if (!list.length) return { ok: true, found: new Map() };
  let res: Response;
  try {
    res = await fetchImpl(`${WHITELIST_SEARCH}/${list.join(",")}?date=${date}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    return { ok: false, error: `whitelist unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: `whitelist ${res.status}: ${(JSON.stringify(json) ?? "").slice(0, 200)}` };
  return { ok: true, found: parseWhitelist(json) };
}
