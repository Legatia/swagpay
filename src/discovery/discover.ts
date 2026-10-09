// Discovery: find print shops in a Polish city, verify each against its own website and the VAT whitelist, save them as vendors.
// Verified means: a NIP with a valid checksum, seen on the shop's own pages, registered (Czynny or Zwolniony) on the whitelist.
import { envNumber } from "../limits";
import { warsawDate } from "../time";
import { knownPrinters, methodsOf, type Suggestion, type VendorStatus } from "../vendors";
import { cityKey, cleanText, shortLegalName } from "./names";
import { isValidNip } from "./nip";
import { extractPage, readPage, type FetchLike } from "./page";
import { searchShops, type FoundShop, type SearchResult } from "./search";
import { checkWhitelist, type Registration, type WhitelistAnswer } from "./whitelist";

export const CITY_CACHE_DAYS = 30;
export const RETRY_AFTER_HOURS = 24;
export const DISCOVERIES_PER_ORDER = 2;
export const FIND_PRINTERS_PER_ORDER = 5;
/** Page fetches one discovery may make (8 shops: a homepage, a contact page, a redirect), well under a Worker's subrequest limit. */
export const PAGE_FETCHES_PER_DISCOVERY = 24;
const DEFAULT_DAILY_MAX = 30;

export interface DiscoveryDeps {
  fetch: FetchLike;
  now: Date;
  /** Takes one model call from a budget; false stops the search before it starts. */
  allowModelCall?: () => Promise<boolean>;
}

export type DiscoveryStatus = "done" | "failed" | "rate_limited";

export interface DiscoveryResult {
  status: DiscoveryStatus;
  found: number;
  verified: number;
  searches: number;
  vendorIds: number[];
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/** `fetchImpl` for at most `max` calls; later calls fail, so the page reads that make them come back empty. */
function budgeted(fetchImpl: FetchLike, max: number): FetchLike {
  let used = 0;
  return async (input, init) => {
    if (++used > max) throw new Error("page budget spent");
    return fetchImpl(input, init);
  };
}

/** Why a discovery won't run now, or null when it may: the city cache (30 days; 24 hours after a failure), 2 per order, the daily maximum. */
export async function discoveryBlocked(env: Env, key: string, orderId: number | null, now: Date): Promise<string | null> {
  const recent = await env.DB
    .prepare("SELECT status, started_at FROM discoveries WHERE city_key = ? AND started_at >= ? ORDER BY started_at DESC, id DESC LIMIT 1")
    .bind(key, new Date(now.getTime() - CITY_CACHE_DAYS * 86_400_000).toISOString())
    .first<{ status: string; started_at: string }>();
  if (recent && (recent.status === "done" || Date.parse(recent.started_at) > now.getTime() - RETRY_AFTER_HOURS * 3_600_000)) {
    return "this city was searched recently";
  }
  if (orderId !== null) {
    const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM discoveries WHERE order_id = ?").bind(orderId).first<{ n: number }>())?.n ?? 0;
    if (n >= DISCOVERIES_PER_ORDER) return "this order already searched twice";
  }
  const today = (await env.DB
    .prepare("SELECT COUNT(*) AS n FROM discoveries WHERE started_at >= ?")
    .bind(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`)
    .first<{ n: number }>())?.n ?? 0;
  if (today >= envNumber(env, "DISCOVERY_DAILY_MAX", DEFAULT_DAILY_MAX)) return "today's search limit is reached";
  return null;
}

interface ReadShop {
  shop: FoundShop;
  siteNips: string[];
  email: string | null;
  methods: string[];
  nipSeenOn: string | null;
}

/** The shop's homepage, and its contact page when the homepage shows no NIP. */
async function readShop(shop: FoundShop, fetchImpl: FetchLike): Promise<ReadShop> {
  const out: ReadShop = { shop, siteNips: [], email: null, methods: [], nipSeenOn: null };
  const home = await readPage(shop.website, fetchImpl);
  if (!home) return out;
  const facts = extractPage(home.html, home.url);
  out.siteNips = facts.nips;
  out.email = facts.email;
  out.methods = facts.methods;
  if (facts.nips.length) {
    out.nipSeenOn = home.url.toString();
  } else if (facts.contactUrl) {
    const contact = await readPage(facts.contactUrl, fetchImpl);
    if (contact) {
      const c = extractPage(contact.html, contact.url);
      out.siteNips = c.nips;
      out.email ??= c.email;
      out.methods = [...new Set([...out.methods, ...c.methods])];
      if (c.nips.length) out.nipSeenOn = contact.url.toString();
    }
  }
  return out;
}

interface ShopRecord {
  name: string;
  city: string;
  methods: string;
  email: string | null;
  website: string;
  nip: string | null;
  taxStatus: string | null;
  taxCheckedAt: string | null;
  status: "screened" | "candidate";
  sourceRef: string;
  registeredName: string | null;
  evidence: string;
}

/**
 * Only a NIP seen on the shop's own pages becomes its tax ID: one only the search answer gave may belong to anyone, so it stays in the
 * evidence (`modelNip`) and never becomes the key later discoveries merge on.
 */
function shopRecord(r: ReadShop, wl: WhitelistAnswer, date: string, links: string[], searchedCity: string): ShopRecord {
  const verified = wl.ok ? r.siteNips.map((n) => wl.found.get(n)).find((x): x is Registration => x !== undefined) ?? null : null;
  const modelNip = r.shop.nip && isValidNip(r.shop.nip) ? r.shop.nip : null;
  const nip = verified?.nip ?? r.siteNips[0] ?? null;
  const registration = verified ?? (wl.ok && nip ? wl.found.get(nip) ?? null : null);
  const methodsFromSite = r.methods.length > 0;
  const evidence = {
    foundFor: cityKey(searchedCity),
    searchLinks: links.slice(0, 5),
    website: r.shop.website.origin,
    nipSeenOn: r.nipSeenOn,
    nipFrom: r.siteNips.length ? "site" : null,
    modelNip: r.siteNips.length ? null : modelNip,
    whitelist: !wl.ok ? { error: wl.error.slice(0, 200), date } : registration ? { ...registration, date } : nip ? { notRegistered: true, date } : null,
    methodsFrom: methodsFromSite ? "site" : "search",
  };
  return {
    name: r.shop.name,
    city: registration?.city ?? searchedCity,
    methods: JSON.stringify(methodsFromSite ? r.methods : r.shop.methods),
    email: r.email,
    website: r.shop.website.origin,
    nip,
    taxStatus: registration?.status ?? null,
    taxCheckedAt: wl.ok && nip ? date : null,
    status: verified ? "screened" : "candidate",
    sourceRef: nip ? `agent:nip:${nip}` : `agent:host:${r.shop.website.hostname.replace(/^www\./, "")}`,
    registeredName: registration?.name ?? null,
    evidence: JSON.stringify(evidence),
  };
}

/**
 * Saves one shop. A vendor with the same tax ID (researched or found before) is updated, not duplicated: empty fields are filled
 * and a candidate may become screened, but a status never drops and partner or paused never changes.
 */
async function saveShop(db: D1Database, s: ShopRecord, nowIso: string): Promise<number> {
  const existing = s.nip ? await db.prepare("SELECT id, status FROM vendors WHERE tax_id = ? ORDER BY id LIMIT 1").bind(s.nip).first<{ id: number; status: VendorStatus }>() : null;
  if (existing) {
    const promoted = existing.status === "candidate" && s.status === "screened";
    // A promotion shows the checks that verified it; otherwise the first evidence stays.
    await db
      .prepare(
        `UPDATE vendors SET registered_name = COALESCE(registered_name, ?), evidence = CASE WHEN ? = 1 THEN ? ELSE COALESCE(evidence, ?) END,
           email = COALESCE(email, ?), website = COALESCE(website, ?), methods = CASE WHEN methods = '[]' THEN ? ELSE methods END,
           tax_status = COALESCE(?, tax_status), tax_checked_at = COALESCE(?, tax_checked_at), status = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(s.registeredName, promoted ? 1 : 0, s.evidence, s.evidence, s.email, s.website, s.methods, s.taxStatus, s.taxCheckedAt,
        promoted ? "screened" : existing.status, nowIso, existing.id)
      .run();
    return existing.id;
  }
  const row = await db
    .prepare(
      `INSERT INTO vendors (name, city, country, methods, email, website, tax_id_type, tax_id, tax_status, tax_checked_at, status, source_ref,
         found_by, registered_name, evidence, created_at, updated_at)
       VALUES (?, ?, 'PL', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'agent', ?, ?, ?, ?)
       ON CONFLICT(source_ref) DO UPDATE SET evidence = excluded.evidence, email = COALESCE(vendors.email, excluded.email),
         tax_status = COALESCE(excluded.tax_status, vendors.tax_status), tax_checked_at = COALESCE(excluded.tax_checked_at, vendors.tax_checked_at),
         registered_name = COALESCE(excluded.registered_name, vendors.registered_name),
         status = CASE WHEN vendors.status = 'candidate' THEN excluded.status ELSE vendors.status END, updated_at = excluded.updated_at
       RETURNING id`,
    )
    .bind(s.name, s.city, s.methods, s.email, s.website, s.nip ? "NIP" : null, s.nip, s.taxStatus, s.taxCheckedAt, s.status, s.sourceRef,
      s.registeredName, s.evidence, nowIso, nowIso)
    .first<{ id: number }>();
  return row!.id;
}

/** Runs one discovery for `city` and records it in `discoveries`. Never throws: failures end as `failed` (search) or `rate_limited` (whitelist). */
export async function discoverPrinters(env: Env, p: { city: string; orderId: number | null }, deps: DiscoveryDeps): Promise<DiscoveryResult> {
  const nowIso = deps.now.toISOString();
  const id = (await env.DB
    .prepare("INSERT INTO discoveries (city_key, city, order_id, started_at) VALUES (?, ?, ?, ?) RETURNING id")
    .bind(cityKey(p.city), p.city, p.orderId, nowIso)
    .first<{ id: number }>())!.id;
  const finish = async (r: DiscoveryResult, error: string | null = null): Promise<DiscoveryResult> => {
    await env.DB
      .prepare("UPDATE discoveries SET finished_at = ?, found = ?, verified = ?, searches = ?, status = ?, error = ? WHERE id = ?")
      .bind(new Date().toISOString(), r.found, r.verified, r.searches, r.status, error, id)
      .run();
    return r;
  };
  const failed = (searches = 0): DiscoveryResult => ({ status: "failed", found: 0, verified: 0, searches, vendorIds: [] });

  let search: SearchResult;
  try {
    if (deps.allowModelCall && !(await deps.allowModelCall())) return await finish(failed(), "the daily model budget is spent");
    search = await searchShops(env as unknown as { GEMINI_API_KEY?: string; GEMINI_MODEL?: string }, p.city, deps.fetch);
  } catch (err) {
    return await finish(failed(), errorText(err));
  }
  if (!search.shops.length) return await finish(failed(search.searches), "no shops in the answer");
  try {
    const pages = budgeted(deps.fetch, PAGE_FETCHES_PER_DISCOVERY);
    // One page that can't be read or parsed never costs the others.
    const read = (await Promise.allSettled(search.shops.map((shop) => readShop(shop, pages))))
      .flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const nips = read.flatMap((r) => r.siteNips);
    const date = warsawDate(deps.now);
    const wl = await checkWhitelist(nips, date, deps.fetch);
    const vendorIds: number[] = [];
    let verified = 0;
    for (const r of read) {
      const rec = shopRecord(r, wl, date, search.links, p.city);
      const vendorId = await saveShop(env.DB, rec, nowIso);
      if (!vendorIds.includes(vendorId)) vendorIds.push(vendorId);
      if (rec.status === "screened") verified++;
    }
    const result: DiscoveryResult = { status: wl.ok ? "done" : "rate_limited", found: search.shops.length, verified, searches: search.searches, vendorIds };
    return await finish(result, wl.ok ? null : wl.error);
  } catch (err) {
    return await finish(failed(search.searches), errorText(err));
  }
}

export interface PrinterInfo {
  id: number;
  /** The registered name, shortened, when known; else the researched name. */
  name: string;
  city: string;
  methods: string[];
  covers: boolean;
  jobs: number;
  onTime: number;
  foundToday: boolean;
}

export interface FindResult {
  inCity: PrinterInfo[];
  elsewhere: PrinterInfo[];
  searched: { found: number; verified: number; status: DiscoveryStatus } | null;
  /** Why no search ran although the city has fewer than 3 printers covering the order. */
  skipped: string | null;
}

/** Verified printers for an order; searches for new ones first when fewer than 3 in the city cover every method (Poland only). */
export async function findPrinters(env: Env, p: { orderId: number; city: string; country: string; methods: string[] }, deps: DiscoveryDeps): Promise<FindResult> {
  const country = p.country.toUpperCase();
  let known = await knownPrinters(env.DB, p.city, country, p.methods);
  let searched: FindResult["searched"] = null;
  let skipped: string | null = null;
  if (known.inCity.filter((s) => s.covers).length < 3) {
    if (country !== "PL") {
      skipped = "searching for new printers only works in Poland";
    } else {
      skipped = await discoveryBlocked(env, cityKey(p.city), p.orderId, deps.now);
      if (!skipped) {
        const r = await discoverPrinters(env, { city: p.city, orderId: p.orderId }, deps);
        searched = { found: r.found, verified: r.verified, status: r.status };
        known = await knownPrinters(env.DB, p.city, country, p.methods);
      }
    }
  }
  const today = deps.now.toISOString().slice(0, 10);
  const info = (s: Suggestion): PrinterInfo => ({
    id: s.vendor.id,
    name: s.vendor.registered_name ? shortLegalName(s.vendor.registered_name) : cleanText(s.vendor.name, 60),
    city: s.vendor.city,
    methods: methodsOf(s.vendor),
    covers: s.covers,
    jobs: s.score.jobs,
    onTime: s.score.onTime,
    foundToday: s.vendor.found_by === "agent" && s.vendor.created_at.slice(0, 10) === today,
  });
  return { inCity: known.inCity.map(info), elsewhere: known.elsewhere.map(info), searched, skipped };
}

/** Nightly: one whitelist search for up to 30 agent-found candidates whose NIP was seen on their own pages but never checked. */
export async function recheckCandidates(env: Env, deps: { fetch: FetchLike; now: Date }): Promise<{ checked: number; verified: number }> {
  const rows = (await env.DB
    .prepare(
      `SELECT id, tax_id, evidence FROM vendors WHERE found_by = 'agent' AND status = 'candidate' AND tax_id IS NOT NULL AND tax_checked_at IS NULL
         AND json_extract(evidence, '$.nipSeenOn') IS NOT NULL ORDER BY id LIMIT 30`,
    )
    .all<{ id: number; tax_id: string; evidence: string | null }>()).results;
  if (!rows.length) return { checked: 0, verified: 0 };
  const date = warsawDate(deps.now);
  const wl = await checkWhitelist(rows.map((r) => r.tax_id), date, deps.fetch);
  if (!wl.ok) return { checked: 0, verified: 0 };
  let verified = 0;
  for (const r of rows) {
    const reg = wl.found.get(r.tax_id) ?? null;
    let evidence: Record<string, unknown> = {};
    try {
      evidence = JSON.parse(r.evidence ?? "{}") as Record<string, unknown>;
    } catch { /* replaced below */ }
    evidence.whitelist = reg ? { ...reg, date } : { notRegistered: true, date };
    await env.DB
      .prepare(
        `UPDATE vendors SET tax_checked_at = ?, tax_status = ?, registered_name = COALESCE(?, registered_name), city = COALESCE(?, city),
           status = CASE WHEN status = 'candidate' AND ? = 1 THEN 'screened' ELSE status END, evidence = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(date, reg?.status ?? null, reg?.name ?? null, reg?.city ?? null, reg ? 1 : 0, JSON.stringify(evidence), deps.now.toISOString(), r.id)
      .run();
    if (reg) verified++;
  }
  return { checked: rows.length, verified };
}
