// One Gemini call with Google Search: print shops in a Polish city. The answer is data; code verifies every shop afterwards.
import { cleanText } from "./names";
import { PRINT_METHODS, safeUrl, type FetchLike } from "./page";

const API = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_SHOPS = 8;
const BLOCKED_HOSTS = [
  "allegro.pl", "olx.pl", "facebook.com", "instagram.com", "google.com", "google.pl", "goo.gl", "etsy.com", "amazon.pl", "amazon.com",
  "ceneo.pl", "youtube.com", "linkedin.com", "tiktok.com", "pinterest.com", "x.com", "twitter.com", "oferteo.pl", "panoramafirm.pl",
];

export interface FoundShop {
  name: string;
  /** The shop's origin (scheme and host). */
  website: URL;
  nip: string | null;
  methods: string[];
}

export interface SearchResult {
  shops: FoundShop[];
  /** Searches Gemini ran (each is billed). */
  searches: number;
  /** Citation links Gemini returned (Google redirect URLs). */
  links: string[];
}

export function searchPrompt(city: string): string {
  return [
    `Find print shops in or near ${city}, Poland, that print t-shirts for businesses (screen printing / sitodruk, DTG or DTF) or make die-cut stickers (naklejki).`,
    "Use Google Search. Prefer shops with their own website that shows their company details.",
    `Answer with a JSON array only, at most ${MAX_SHOPS} entries, each {"name": string, "website": string, "nip": string or null, "methods": array of "screen", "dtg", "dtf", "diecut", "banner"}.`,
    "Give each shop's own website, not a marketplace or a social profile. Give the NIP only if you saw it; never guess it.",
  ].join("\n");
}

/** The first JSON array of objects in an answer: each fenced block in turn, then the whole text; citation markers ("[1]") are dropped if they break it. */
function answerArray(text: string): unknown {
  const sources = [...[...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]), text];
  for (const src of sources) {
    const found = firstJsonArray(src) ?? firstJsonArray(src.replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, ""));
    if (found !== null) return found;
  }
  return null;
}

/** The first JSON array of objects in `src`, by bracket matching from the first "[{"; null when it doesn't parse. */
function firstJsonArray(src: string): unknown {
  const start = src.search(/\[\s*\{/);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(src.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** The shops in a grounded answer: entries with a name and a usable website, marketplaces and social sites dropped, one per host, at most 8. */
export function parseShops(text: string): FoundShop[] {
  const raw = answerArray(text);
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: FoundShop[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const e = r as Record<string, unknown>;
    const name = typeof e.name === "string" ? cleanText(e.name, 60) : "";
    const site = typeof e.website === "string" ? safeUrl(/^[a-z]+:/i.test(e.website.trim()) ? e.website.trim() : `https://${e.website.trim()}`) : null;
    if (!name || !site) continue;
    const host = site.hostname.toLowerCase().replace(/^www\./, "");
    if (BLOCKED_HOSTS.some((b) => host === b || host.endsWith(`.${b}`)) || seen.has(host)) continue;
    seen.add(host);
    const digits = typeof e.nip === "string" ? e.nip.replace(/\D/g, "") : "";
    const methods = Array.isArray(e.methods)
      ? [...new Set(e.methods.filter((m): m is string => typeof m === "string" && (PRINT_METHODS as readonly string[]).includes(m)))]
      : [];
    out.push({ name, website: new URL(site.origin), nip: digits.length === 10 ? digits : null, methods });
    if (out.length >= MAX_SHOPS) break;
  }
  return out;
}

type Candidate = {
  content?: { parts?: Array<{ text?: unknown; thought?: unknown }> };
  groundingMetadata?: { webSearchQueries?: unknown; groundingChunks?: Array<{ web?: { uri?: unknown } }> };
};

export function parseSearchResponse(json: unknown): SearchResult {
  const cand = (json as { candidates?: Candidate[] } | null)?.candidates?.[0];
  const text = (cand?.content?.parts ?? []).filter((p) => p.thought !== true && typeof p.text === "string").map((p) => p.text as string).join("");
  const meta = cand?.groundingMetadata;
  return {
    shops: parseShops(text),
    searches: Array.isArray(meta?.webSearchQueries) ? meta.webSearchQueries.length : 0,
    links: (meta?.groundingChunks ?? []).map((c) => c.web?.uri).filter((u): u is string => typeof u === "string").slice(0, 20),
  };
}

/** Asks Gemini (the agents' model) with Google Search for shops in `city`. Throws on a missing key or an HTTP error. */
export async function searchShops(env: { GEMINI_API_KEY?: string; GEMINI_MODEL?: string }, city: string, fetchImpl: FetchLike): Promise<SearchResult> {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
  const model = env.GEMINI_MODEL || "gemini-3.8-flash";
  const res = await fetchImpl(`${API}/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: searchPrompt(city) }] }],
      tools: [{ google_search: {} }],
      generationConfig: { maxOutputTokens: 8000 },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: unknown } };
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${String(json.error?.message ?? res.statusText).slice(0, 200)}`);
  return parseSearchResponse(json);
}
