interface Jwk {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
}

let cache: { url: string; at: number; keys: Jwk[] } | null = null;
const CACHE_MS = 10 * 60 * 1000;

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function decodeJson(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(s))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function certs(teamDomain: string, fetchImpl: typeof fetch, now: number, refresh: boolean): Promise<Jwk[]> {
  const url = `${teamDomain}/cdn-cgi/access/certs`;
  if (!refresh && cache && cache.url === url && now - cache.at < CACHE_MS) return cache.keys;
  const res = await fetchImpl(url);
  if (!res.ok) return [];
  const body = (await res.json()) as { keys?: Jwk[] };
  cache = { url, at: now, keys: body.keys ?? [] };
  return cache.keys;
}

/** Verifies a Cloudflare Access JWT (RS256). Returns the identity, or null for anything invalid. */
export async function verifyAccessJwt(
  token: string | null,
  teamDomain: string,
  aud: string,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<{ email: string | null } | null> {
  teamDomain = teamDomain.replace(/\/+$/, "");
  if (!token || !teamDomain || !aud) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const header = decodeJson(parts[0]);
  const payload = decodeJson(parts[1]);
  if (!header || !payload || header.alg !== "RS256" || typeof header.kid !== "string") return null;
  let jwk: Jwk | undefined;
  try {
    jwk = (await certs(teamDomain, fetchImpl, now, false)).find((k) => k.kid === header.kid);
    if (!jwk) jwk = (await certs(teamDomain, fetchImpl, now, true)).find((k) => k.kid === header.kid);
  } catch (err) {
    console.error("access certs fetch failed", err);
    return null;
  }
  if (!jwk?.n || !jwk.e) return null;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
  } catch {
    return null;
  }
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return null;
  if (payload.iss !== teamDomain) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) return null;
  return { email: typeof payload.email === "string" ? payload.email : null };
}
