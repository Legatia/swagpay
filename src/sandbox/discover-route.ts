// Sandbox only: the live check for discovery. POST {city} with the DISCOVERY_CHECK_TOKEN bearer runs one discovery (the city cache
// and the daily limit apply) and returns its counts. It needs no captcha, so it also warms up cities before a demo.
import { discoverPrinters, discoveryBlocked } from "../discovery/discover";
import { CITY_PATTERN, cityKey } from "../discovery/names";
import { takeModelCall } from "../limits";
import { isSandbox } from "./config";

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function handleSandboxDiscover(request: Request, env: Env): Promise<Response> {
  const token = (env as unknown as { DISCOVERY_CHECK_TOKEN?: string }).DISCOVERY_CHECK_TOKEN;
  if (!isSandbox(env) || !token) return json(404, { error: "not found" });
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (given !== token) return json(401, { error: "unauthorized" });
  const body = (await request.json().catch(() => null)) as { city?: unknown } | null;
  const city = typeof body?.city === "string" ? body.city.trim() : "";
  if (!CITY_PATTERN.test(city)) return json(400, { error: "city: 1 to 40 letters, spaces or hyphens" });
  const now = new Date();
  const skipped = await discoveryBlocked(env, cityKey(city), null, now);
  if (skipped) return json(200, { skipped });
  return json(200, await discoverPrinters(env, { city, orderId: null }, { fetch: (u, i) => fetch(u, i), now, allowModelCall: () => takeModelCall(env) }));
}
