// Reading a print shop's own pages: the fetch rules, and the facts code takes from them. Page text never reaches a model.
import { findNips } from "./nip";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const PRINT_METHODS = ["screen", "dtg", "dtf", "diecut", "banner"] as const;

const MAX_BYTES = 300_000;
const TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;

/** An http(s) URL on a default port with a public-looking host name; null for IP literals, localhost, odd ports, credentials or other schemes. */
export function safeUrl(raw: string, base?: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.port !== "" || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || host.startsWith("[") || host.includes(":") || /^[\d.]+$/.test(host)) return null;
  if (host === "localhost" || /\.(localhost|local|internal|lan|home|arpa)$/.test(host)) return null;
  return u;
}

/** The first 300 KB of a response body as text. */
async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < max) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = value.byteLength > max - total ? value.subarray(0, max - total) : value;
    chunks.push(take);
    total += take.byteLength;
  }
  await reader.cancel().catch(() => {});
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** GETs one page under the fetch rules: redirects followed by hand (at most 3, each re-checked), 5 s, HTML only, the first 300 KB. Null when it can't be read. */
export async function readPage(url: URL, fetchImpl: FetchLike): Promise<{ url: URL; html: string } | null> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Response;
    try {
      res = await fetchImpl(current.toString(), {
        redirect: "manual",
        headers: { accept: "text/html", "user-agent": "SwagpayPrinterCheck/1.0 (+https://swagpay.me)" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      const next = location ? safeUrl(location, current.toString()) : null;
      if (!next) return null;
      current = next;
      continue;
    }
    if (!res.ok || !(res.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) return null;
    try {
      return { url: current, html: await readCapped(res, MAX_BYTES) };
    } catch {
      return null;
    }
  }
  return null;
}

/** Visible text: scripts, styles and tags dropped, common entities decoded, whitespace collapsed. */
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&#(\d{1,7});/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ");
}

const METHOD_WORDS: Array<[(typeof PRINT_METHODS)[number], RegExp]> = [
  ["screen", /sitodruk|screen ?print/],
  ["dtg", /\bdtg\b/],
  ["dtf", /\bdtf\b/],
  ["diecut", /naklejk|die ?cut|kiss ?cut/],
  ["banner", /\bbaner|\bbanner/],
];
const MAILBOXES = new Set(["gmail.com", "wp.pl", "o2.pl", "onet.pl", "interia.pl", "op.pl"]);

export interface PageFacts {
  nips: string[];
  email: string | null;
  methods: string[];
  /** A same-host contact page (kontakt/contact first, then o-nas/about), or null. */
  contactUrl: URL | null;
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** What one shop page says about the shop: valid NIPs, an email on its own domain (or a common Polish mailbox), print methods, a contact page. */
export function extractPage(html: string, pageUrl: URL): PageFacts {
  const text = htmlText(html);
  const folded = text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const host = pageUrl.hostname.toLowerCase().replace(/^www\./, "");
  const emails = [
    ...[...html.matchAll(/mailto:([^"'?\s>]+)/gi)].map((m) => decodeSafe(m[1])),
    ...[...text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map((m) => m[0]),
  ].map((e) => e.trim().toLowerCase());
  const email = emails.find((e) => {
    const domain = e.split("@")[1] ?? "";
    return domain === host || domain.endsWith(`.${host}`) || host.endsWith(`.${domain}`) || MAILBOXES.has(domain);
  }) ?? null;
  const links = [...html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)]
    .map((m) => safeUrl(m[1].trim(), pageUrl.toString()))
    .filter((u): u is URL => u !== null && u.hostname === pageUrl.hostname && u.pathname !== pageUrl.pathname);
  const contactUrl = links.find((u) => /kontakt|contact/i.test(u.pathname)) ?? links.find((u) => /o-nas|about/i.test(u.pathname)) ?? null;
  return { nips: findNips(text), email, methods: METHOD_WORDS.filter(([, re]) => re.test(folded)).map(([m]) => m), contactUrl };
}
