import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { discoverPrinters, discoveryBlocked, findPrinters, recheckCandidates } from "../../src/discovery/discover";
import type { FetchLike } from "../../src/discovery/page";
import { handleApi } from "../../src/api";
import { getVendor } from "../../src/vendors";
import { geminiAnswer, page, whitelistAnswer } from "./fixtures";

const live = { ...env, GEMINI_API_KEY: "test-key" } as unknown as Env;
const NOW = new Date("2099-10-09T10:00:00Z");
const GEMINI = "https://generativelanguage.googleapis.com/";
const WL = "https://wl-api.mf.gov.pl/";

/** A fake fetch: the first route whose prefix matches answers; anything else is a 404. Records every URL. */
function router(routes: Array<[string, (url: string) => Response]>): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (input) => {
      const url = String(input);
      calls.push(url);
      const hit = routes.find(([prefix]) => url.startsWith(prefix));
      return hit ? hit[1](url) : new Response("not found", { status: 404 });
    },
  };
}

async function addVendor(name: string, city: string, status: string, methods: string[], extra: { taxId?: string; country?: string } = {}): Promise<number> {
  return (await env.DB
    .prepare("INSERT INTO vendors (name, city, country, methods, status, tax_id, source_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'x', 'x') RETURNING id")
    .bind(name, city, extra.country ?? "PL", JSON.stringify(methods), status, extra.taxId ?? null, `test:${crypto.randomUUID()}`)
    .first<{ id: number }>())!.id;
}

const discovery = async (city: string) =>
  env.DB.prepare("SELECT * FROM discoveries WHERE city = ? ORDER BY id DESC LIMIT 1").bind(city).first<{ status: string; found: number; verified: number; searches: number; error: string | null; finished_at: string | null }>();

describe("discoverPrinters", () => {
  it("verifies a shop whose own site shows a registered NIP", async () => {
    const r = router([
      [GEMINI, () => geminiAnswer([{ name: "Druk Gdańsk", website: "https://druk-gdansk.pl", nip: null, methods: ["banner"] }])],
      ["https://druk-gdansk.pl/", () => page(`<p>Sitodruk i DTF</p><footer>NIP: 123-456-32-18 <a href="mailto:biuro@druk-gdansk.pl">napisz</a></footer>`)],
      [WL, () => whitelistAnswer({ "1234563218": { name: "DRUK GDAŃSK SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ", status: "Czynny", address: "UL. DŁUGA 1, 80-001 GDAŃSK" } })],
    ]);
    const res = await discoverPrinters(live, { city: "Gdańsk", orderId: null }, { fetch: r.fetch, now: NOW });
    expect(res).toMatchObject({ status: "done", found: 1, verified: 1, searches: 3 });
    const v = (await getVendor(env.DB, res.vendorIds[0]))!;
    expect(v).toMatchObject({
      status: "screened", found_by: "agent", name: "Druk Gdańsk", city: "Gdańsk", country: "PL", tax_id_type: "NIP", tax_id: "1234563218",
      tax_status: "Czynny", tax_checked_at: "2099-10-09", email: "biuro@druk-gdansk.pl", website: "https://druk-gdansk.pl", source_ref: "agent:nip:1234563218",
      registered_name: "DRUK GDAŃSK SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ",
    });
    expect(JSON.parse(v.methods)).toEqual(["screen", "dtf"]); // the site's words win over the search answer's
    expect(JSON.parse(v.evidence!)).toMatchObject({
      nipSeenOn: "https://druk-gdansk.pl/", nipFrom: "site", methodsFrom: "site",
      whitelist: { status: "Czynny", city: "Gdańsk", date: "2099-10-09" },
      searchLinks: ["https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc"],
    });
    expect(r.calls.filter((u) => u.startsWith(WL))).toEqual(["https://wl-api.mf.gov.pl/api/search/nips/1234563218?date=2099-10-09"]);
    expect(await discovery("Gdańsk")).toMatchObject({ status: "done", found: 1, verified: 1, searches: 3, error: null });
  });

  it("keeps a shop whose NIP only came from the search answer as a candidate", async () => {
    const r = router([
      [GEMINI, () => geminiAnswer([{ name: "Nadruki Gdynia", website: "nadruki-gdynia.pl", nip: "2222222222", methods: ["dtg"] }])],
      ["https://nadruki-gdynia.pl/", () => page("<p>Koszulki z nadrukiem</p>")],
      [WL, () => whitelistAnswer({ "2222222222": { name: "SOMEONE ELSE SP. Z O.O.", status: "Czynny", address: "00-001 WARSZAWA" } })],
    ]);
    const res = await discoverPrinters(live, { city: "Gdynia", orderId: null }, { fetch: r.fetch, now: NOW });
    expect(res).toMatchObject({ status: "done", found: 1, verified: 0 });
    const v = (await getVendor(env.DB, res.vendorIds[0]))!;
    expect(v).toMatchObject({ status: "candidate", tax_id: "2222222222", found_by: "agent" });
    expect(JSON.parse(v.methods)).toEqual(["dtg"]);
    expect(JSON.parse(v.evidence!)).toMatchObject({ nipSeenOn: null, nipFrom: "search", methodsFrom: "search" });
  });

  it("keeps a shop whose NIP isn't registered as a candidate, checked today", async () => {
    const r = router([
      [GEMINI, () => geminiAnswer([{ name: "Druk Sopot", website: "https://druk-sopot.pl", nip: null, methods: [] }])],
      ["https://druk-sopot.pl/", () => page("<p>NIP 3333333333, naklejki</p>")],
      [WL, () => Response.json({ result: { entries: [{ identifier: "3333333333", subjects: [] }] } })],
    ]);
    const res = await discoverPrinters(live, { city: "Sopot", orderId: null }, { fetch: r.fetch, now: NOW });
    const v = (await getVendor(env.DB, res.vendorIds[0]))!;
    expect(v).toMatchObject({ status: "candidate", tax_id: "3333333333", tax_checked_at: "2099-10-09", tax_status: null, city: "Sopot" });
    expect(JSON.parse(v.evidence!).whitelist).toEqual({ notRegistered: true, date: "2099-10-09" });
  });

  it("leaves shops unverified when the whitelist doesn't answer, and the nightly re-check verifies them", async () => {
    const r = router([
      [GEMINI, () => geminiAnswer([{ name: "Druk Rumia", website: "https://druk-rumia.pl", nip: null, methods: [] }])],
      ["https://druk-rumia.pl/", () => page("<p>DTF. NIP: 4444444444</p>")],
      [WL, () => Response.json({ code: "WL-190", message: "limit" }, { status: 429 })],
    ]);
    const res = await discoverPrinters(live, { city: "Rumia", orderId: null }, { fetch: r.fetch, now: NOW });
    expect(res).toMatchObject({ status: "rate_limited", verified: 0 });
    expect((await discovery("Rumia"))?.error).toContain("whitelist 429");
    const id = res.vendorIds[0];
    expect(await getVendor(env.DB, id)).toMatchObject({ status: "candidate", tax_id: "4444444444", tax_checked_at: null });

    const ok = router([[WL, () => whitelistAnswer({ "4444444444": { name: "DRUK RUMIA SPÓŁKA JAWNA", status: "Zwolniony", address: "84-230 RUMIA" } })]]);
    expect(await recheckCandidates(env, { fetch: ok.fetch, now: NOW })).toMatchObject({ verified: 1 });
    expect(await getVendor(env.DB, id)).toMatchObject({ status: "screened", tax_status: "Zwolniony", tax_checked_at: "2099-10-09", registered_name: "DRUK RUMIA SPÓŁKA JAWNA", city: "Rumia" });
    expect(await recheckCandidates(env, { fetch: ok.fetch, now: NOW })).toEqual({ checked: 0, verified: 0 });
  });

  it("reads the contact page when the homepage has no NIP", async () => {
    const r = router([
      [GEMINI, () => geminiAnswer([{ name: "Druk Reda", website: "https://druk-reda.pl", nip: null, methods: ["screen"] }])],
      ["https://druk-reda.pl/kontakt", () => page("<p>NIP: 5555555555</p>")],
      ["https://druk-reda.pl/", () => page(`<p>Sitodruk</p><a href="/kontakt">Kontakt</a>`)],
      [WL, () => whitelistAnswer({ "5555555555": { name: "DRUK REDA", status: "Czynny", address: "84-240 REDA" } })],
    ]);
    const res = await discoverPrinters(live, { city: "Reda", orderId: null }, { fetch: r.fetch, now: NOW });
    expect(res.verified).toBe(1);
    expect(JSON.parse((await getVendor(env.DB, res.vendorIds[0]))!.evidence!).nipSeenOn).toBe("https://druk-reda.pl/kontakt");
  });

  it("updates a researched printer with the same NIP instead of adding it again, keeping its status", async () => {
    const id = await addVendor("Old Name", "Warsaw", "partner", ["screen"], { taxId: "6666666666" });
    const r = router([
      [GEMINI, () => geminiAnswer([{ name: "New Name", website: "https://six.pl", nip: null, methods: [] }])],
      ["https://six.pl/", () => page("<p>NIP 6666666666</p>")],
      [WL, () => whitelistAnswer({ "6666666666": { name: "SIX SP. Z O.O.", status: "Czynny", address: "00-001 WARSZAWA" } })],
    ]);
    const res = await discoverPrinters(live, { city: "Pruszków", orderId: null }, { fetch: r.fetch, now: NOW });
    expect(res.vendorIds).toEqual([id]);
    expect(await getVendor(env.DB, id)).toMatchObject({ status: "partner", name: "Old Name", registered_name: "SIX SP. Z O.O.", found_by: "research" });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM vendors WHERE tax_id = '6666666666'").first<{ n: number }>())?.n).toBe(1);
  });

  it("records a failed search and saves nothing", async () => {
    const r = router([[GEMINI, () => Response.json({ error: { message: "quota" } }, { status: 500 })]]);
    const res = await discoverPrinters(live, { city: "Hel", orderId: null }, { fetch: r.fetch, now: NOW });
    expect(res).toEqual({ status: "failed", found: 0, verified: 0, searches: 0, vendorIds: [] });
    expect(await discovery("Hel")).toMatchObject({ status: "failed", error: "Gemini 500: quota" });
  });

  it("stops before the search when the model budget says no", async () => {
    const r = router([]);
    const res = await discoverPrinters(live, { city: "Jastarnia", orderId: null }, { fetch: r.fetch, now: NOW, allowModelCall: async () => false });
    expect(res.status).toBe("failed");
    expect(r.calls).toEqual([]);
    expect((await discovery("Jastarnia"))?.error).toBe("the daily model budget is spent");
  });
});

describe("discoveryBlocked", () => {
  const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();
  const insert = (key: string, hoursAgo: number, status: string, orderId: number | null = null) =>
    env.DB.prepare("INSERT INTO discoveries (city_key, city, order_id, started_at, status) VALUES (?, ?, ?, ?, ?)").bind(key, key, orderId, at(hoursAgo), status).run();

  it("searches a city at most once in 30 days, or again a day after a failure", async () => {
    await insert("torun", 24 * 29, "done");
    expect(await discoveryBlocked(env, "torun", null, NOW)).toBe("this city was searched recently");
    await insert("olsztyn", 24 * 31, "done");
    expect(await discoveryBlocked(env, "olsztyn", null, NOW)).toBeNull();
    await insert("opole", 25, "failed");
    expect(await discoveryBlocked(env, "opole", null, NOW)).toBeNull();
    await insert("kielce", 2, "rate_limited");
    expect(await discoveryBlocked(env, "kielce", null, NOW)).toBe("this city was searched recently");
  });

  it("allows two searches per order and the daily maximum", async () => {
    await insert("plock", 40, "done", 991);
    await insert("radom", 40, "failed", 991);
    expect(await discoveryBlocked(env, "lublin", 991, NOW)).toBe("this order already searched twice");
    expect(await discoveryBlocked(env, "lublin", 992, NOW)).toBeNull();
    await insert("zamosc", 1, "done");
    expect(await discoveryBlocked({ ...env, DISCOVERY_DAILY_MAX: "1" } as unknown as Env, "lublin", null, NOW)).toBe("today's search limit is reached");
  });
});

describe("findPrinters", () => {
  it("returns verified printers without searching when three in the city cover the order", async () => {
    for (const n of ["A", "B", "C"]) await addVendor(`Gniezno Print ${n}`, "Gniezno", "screened", ["screen", "diecut"]);
    await addVendor("Gniezno Candidate", "Gniezno", "candidate", ["screen"]);
    await addVendor("Września Paused", "Września", "paused", ["screen"]);
    await addVendor("Września Print", "Września", "screened", ["screen"]);
    await addVendor("Leeds Print", "Leeds", "screened", ["screen"], { country: "GB" });
    const r = router([]);
    const res = await findPrinters(live, { orderId: 1, city: "gniezno", country: "PL", methods: ["screen", "diecut"] }, { fetch: r.fetch, now: NOW });
    expect(r.calls).toEqual([]);
    expect(res.inCity.map((p) => p.name)).toEqual(["Gniezno Print A", "Gniezno Print B", "Gniezno Print C"]);
    expect(res.inCity[0]).toMatchObject({ city: "Gniezno", methods: ["screen", "diecut"], covers: true, jobs: 0, onTime: 0, foundToday: false });
    // Elsewhere: at most 3 verified printers in Poland outside the city (other tests in this file add some too).
    expect(res.elsewhere.length).toBeGreaterThan(0);
    expect(res.elsewhere.length).toBeLessThanOrEqual(3);
    for (const p of res.elsewhere) {
      expect(p.city).not.toBe("Gniezno");
      expect(["Września Paused", "Leeds Print", "Gniezno Candidate"]).not.toContain(p.name);
      const v = await getVendor(env.DB, p.id);
      expect(v?.country).toBe("PL");
      expect(["screened", "partner"]).toContain(v?.status);
    }
    expect(res).toMatchObject({ searched: null, skipped: null });
  });

  it("matches Warsaw printers for Warszawa and doesn't search a city searched recently", async () => {
    await addVendor("Warsaw Print", "Warsaw", "screened", ["dtg"]);
    await env.DB.prepare("INSERT INTO discoveries (city_key, city, started_at, status) VALUES ('warszawa', 'Warszawa', ?, 'done')").bind(NOW.toISOString()).run();
    const r = router([]);
    const res = await findPrinters(live, { orderId: 2, city: "Warszawa", country: "PL", methods: ["dtg"] }, { fetch: r.fetch, now: NOW });
    expect(res.inCity.map((p) => p.name)).toContain("Warsaw Print");
    expect(res.skipped).toBe("this city was searched recently");
    expect(r.calls).toEqual([]);
  });

  it("only searches in Poland", async () => {
    const r = router([]);
    const res = await findPrinters(live, { orderId: 3, city: "Leeds", country: "GB", methods: ["screen"] }, { fetch: r.fetch, now: NOW });
    expect(res.skipped).toBe("searching for new printers only works in Poland");
    expect(r.calls).toEqual([]);
  });

  it("searches a city with too few printers and lists the new one by its registered name", async () => {
    const r = router([
      [GEMINI, () => geminiAnswer([{ name: "Elbląg Druk", website: "https://elblag-druk.pl", nip: null, methods: [] }])],
      ["https://elblag-druk.pl/", () => page("<p>Sitodruk. NIP: 7777777777</p>")],
      [WL, () => whitelistAnswer({ "7777777777": { name: "ELBLĄG DRUK SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ", status: "Czynny", address: "82-300 ELBLĄG" } })],
    ]);
    const res = await findPrinters(live, { orderId: 4, city: "Elblag", country: "pl", methods: ["screen"] }, { fetch: r.fetch, now: NOW });
    expect(res.searched).toEqual({ found: 1, verified: 1, status: "done" });
    expect(res.inCity).toEqual([expect.objectContaining({ name: "ELBLĄG DRUK sp. z o.o.", city: "Elbląg", covers: true, foundToday: true })]);
  });
});

describe("live check route", () => {
  const sbx = { ...env, SANDBOX: "1", ARC_CHAIN_ID: "5042002", DISCOVERY_CHECK_TOKEN: "check-token" } as unknown as Env;
  const call = (e: Env, body: unknown, token?: string) =>
    handleApi(new Request("https://sandbox.test/api/sandbox/discover", { method: "POST", body: JSON.stringify(body), headers: token ? { authorization: `Bearer ${token}` } : {} }), e);

  it("exists only in the sandbox with a token, and checks its input", async () => {
    expect((await call({ ...env, DISCOVERY_CHECK_TOKEN: "check-token" } as unknown as Env, { city: "Gdańsk" }, "check-token")).status).toBe(404);
    expect((await call({ ...sbx, DISCOVERY_CHECK_TOKEN: "" } as unknown as Env, { city: "Gdańsk" }, "")).status).toBe(404);
    expect((await call(sbx, { city: "Gdańsk" }, "wrong")).status).toBe(401);
    expect((await call(sbx, { city: "Gd4nsk" }, "check-token")).status).toBe(400);
    await env.DB.prepare("INSERT INTO discoveries (city_key, city, started_at, status) VALUES ('ustka', 'Ustka', ?, 'done')").bind(new Date().toISOString()).run();
    const res = await call(sbx, { city: "Ustka" }, "check-token");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "this city was searched recently" });
  });
});
