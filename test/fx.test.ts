import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { NBP_BASE, fetchNbpRate, plnPer, ratesFor, refreshRates } from "../src/fx";

function nbp(rates: Record<string, number>, seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    const code = /\/a\/(\w+)\//.exec(url)?.[1]?.toUpperCase() ?? "";
    if (!(code in rates)) return new Response("Not Found", { status: 404 });
    return Response.json({ table: "A", currency: "x", code, rates: [{ no: "189/A/NBP/2099", effectiveDate: "2099-09-30", mid: rates[code] }] });
  }) as typeof fetch;
}

describe("NBP rates", () => {
  it("reads the mid rate from table A", async () => {
    const seen: string[] = [];
    expect(await fetchNbpRate("USD", nbp({ USD: 3.6412 }, seen))).toEqual({ plnPerUnit: 3.6412, effectiveDate: "2099-09-30" });
    expect(seen[0]).toBe(`${NBP_BASE}/usd/?format=json`);
  });

  it("throws on errors and odd responses", async () => {
    await expect(fetchNbpRate("EUR", nbp({}))).rejects.toThrow("HTTP 404");
    const odd = (async () => Response.json({ rates: [{ mid: "x" }] })) as unknown as typeof fetch;
    await expect(fetchNbpRate("EUR", odd)).rejects.toThrow("unexpected response");
  });

  it("accepts only a positive finite number as the mid rate", async () => {
    for (const mid of [0, -4.2, undefined, true, "4.2", null]) {
      const answer = (async () => Response.json({ rates: [{ mid, effectiveDate: "2099-09-30" }] })) as unknown as typeof fetch;
      await expect(fetchNbpRate("EUR", answer), String(mid)).rejects.toThrow("unexpected response");
    }
  });

  it("stores both rates and derives USD per EUR", async () => {
    const now = new Date("2099-10-01T10:00:00Z");
    await refreshRates(env.DB, nbp({ USD: 4, EUR: 4.3 }), now);
    expect(await ratesFor(env.DB, "USD", now)).toEqual({ plnPerUnit: 4, usdPerUnit: 1 });
    const eur = await ratesFor(env.DB, "EUR", now);
    expect(eur?.plnPerUnit).toBe(4.3);
    expect(eur?.usdPerUnit).toBeCloseTo(1.075, 10);
  });

  it("treats rates older than six hours as missing", async () => {
    const then = new Date("2099-10-01T10:00:00Z");
    await refreshRates(env.DB, nbp({ USD: 4, EUR: 4.3 }), then);
    expect(await ratesFor(env.DB, "USD", new Date(then.getTime() + 6 * 3_600_000))).not.toBeNull();
    expect(await ratesFor(env.DB, "USD", new Date(then.getTime() + 6 * 3_600_000 + 1))).toBeNull();
    expect(await ratesFor(env.DB, "EUR", new Date(then.getTime() + 7 * 3_600_000))).toBeNull();
  });
  it("refreshes GBP and INR when NBP has them, and USD/EUR even when those fail", async () => {
    const now = new Date("2099-10-02T10:00:00Z");
    await refreshRates(env.DB, nbp({ USD: 4, EUR: 4.3, GBP: 5, INR: 0.045 }), now);
    expect(await plnPer(env.DB, "GBP", now)).toBe(5);
    expect(await plnPer(env.DB, "INR", now)).toBe(0.045);
    expect(await plnPer(env.DB, "PLN", now)).toBe(1);
    const later = new Date("2099-10-02T11:00:00Z");
    await refreshRates(env.DB, nbp({ USD: 4.1, EUR: 4.4 }), later);
    expect(await plnPer(env.DB, "USD", later)).toBe(4.1);
    // GBP kept its older (still fresh) row.
    expect(await plnPer(env.DB, "GBP", later)).toBe(5);
    expect(await plnPer(env.DB, "GBP", new Date("2099-10-03T10:00:00Z"))).toBeNull();
    expect(await plnPer(env.DB, "XYZ", later)).toBeNull();
  });
});
