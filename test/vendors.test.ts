import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { toVendorRows, upsertSql } from "../scripts/vendors-import-lib.mjs";
import { createOrder } from "../src/db";
import { IntakeSchema } from "../src/intake";
import { createObligation, getObligation } from "../src/treasury";
import {
  cityFromPlace, getVendor, listVendors, markJob, proposeVendorJob, setVendorPayout, setVendorStatus, suggestVendors, vendorJobFor, vendorScore,
  type VendorRow, type VendorStatus,
} from "../src/vendors";

const NOW = "2099-01-01T10:00:00.000Z";
let n = 0;
async function vendor(o: { name: string; city?: string; status?: VendorStatus; methods?: string[] }): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO vendors (name, city, country, methods, status, source_ref, created_at, updated_at) VALUES (?, ?, 'PL', ?, ?, ?, ?, ?)`,
  ).bind(o.name, o.city ?? "Warsaw", JSON.stringify(o.methods ?? ["screen"]), o.status ?? "partner", `t:${++n}`, NOW, NOW).run();
  return res.meta.last_row_id as number;
}
async function order(): Promise<number> {
  const { order } = await createOrder(env.DB, IntakeSchema.parse({
    eventName: "Meetup", eventDate: "2099-10-08", deliverBy: "2099-10-08T17:00",
    deliveryPlace: "Kolektyw3, Koszykowa 54, Warsaw", contactName: "Ana", contactEmail: "ana@example.com", request: "60 black tees please",
  }), new Date(NOW));
  return order.id;
}
const job = (orderId: number, vendorId: number, deliverBy = "2099-10-08T15:00:00.000Z") => ({ orderId, vendorId, deliverBy, currency: "PLN", cents: 120_000 });
const ADDR = "0x" + "a".repeat(40);

describe("cityFromPlace", () => {
  it("finds the four cities by name or alias", () => {
    expect(cityFromPlace("Kolektyw3, Koszykowa 54, Warszawa")).toBe("Warsaw");
    expect(cityFromPlace("MEO Arena, Lisboa")).toBe("Lisbon");
    expect(cityFromPlace("Olympia London")).toBe("London");
    expect(cityFromPlace("Jio World Centre, BKC, Mumbai")).toBe("Mumbai");
    expect(cityFromPlace("Berlin")).toBeNull();
    expect(cityFromPlace("Londonderry")).toBeNull();
    expect(cityFromPlace("Warsaw Road, London")).toBe("London");
    expect(cityFromPlace("Bombay Street, London")).toBe("London");
    expect(cityFromPlace("London Road, Warsaw")).toBe("Warsaw");
    expect(cityFromPlace("Kolektyw3 w Warszawie")).toBe("Warsaw");
  });
});

describe("suggestVendors", () => {
  it("ranks partners, then full coverage, then on-time jobs, then name; hides candidates, paused and other cities", async () => {
    const city = "Testville";
    const partnerSome = await vendor({ name: "B partner some", city, status: "partner", methods: ["screen"] });
    const partnerAll = await vendor({ name: "C partner all", city, status: "partner", methods: ["screen", "dtf"] });
    const screenedAll = await vendor({ name: "A screened all", city, status: "screened", methods: ["screen", "dtf"] });
    const partnerAll2 = await vendor({ name: "D partner all", city, status: "partner", methods: ["dtf", "screen", "banner"] });
    await vendor({ name: "cand", city, status: "candidate", methods: ["screen", "dtf"] });
    await vendor({ name: "paused", city, status: "paused", methods: ["screen", "dtf"] });
    await vendor({ name: "elsewhere", city: "Other", status: "partner", methods: ["screen", "dtf"] });

    // D has one on-time delivered job, so it outranks C.
    const o = await order();
    await proposeVendorJob(env.DB, job(o, partnerAll2));
    await markJob(env.DB, o, "booked");
    await markJob(env.DB, o, "delivered", new Date("2099-10-08T10:00:00Z"));

    const res = await suggestVendors(env.DB, city, ["screen", "dtf"], 10);
    expect(res.map((r) => r.vendor.id)).toEqual([partnerAll2, partnerAll, partnerSome, screenedAll]);
    expect(res.map((r) => r.covers)).toEqual([true, true, false, true]);
    expect(res[0].score).toEqual({ jobs: 1, onTime: 1 });
    expect((await suggestVendors(env.DB, city, ["screen", "dtf"], 2))).toHaveLength(2);
  });
});

describe("vendor status and payout", () => {
  it("sets status and lists by city and status", async () => {
    const id = await vendor({ name: "S", city: "Lisbon", status: "screened" });
    expect(await setVendorStatus(env.DB, id, "partner")).toBe(true);
    expect(await setVendorStatus(env.DB, 999_999, "partner")).toBe(false);
    expect((await getVendor(env.DB, id))?.status).toBe("partner");
    expect((await listVendors(env.DB, { city: "Lisbon", statuses: ["partner"] })).map((v) => v.id)).toEqual([id]);
    expect(await listVendors(env.DB, { city: "Lisbon", statuses: ["paused"] })).toEqual([]);
  });

  it("clears the payout when a vendor leaves partner, so it must register again", async () => {
    for (const away of ["paused", "screened", "candidate"] as const) {
      const id = await vendor({ name: `Away ${away}` });
      expect(await setVendorPayout(env.DB, id, ADDR, "ARC")).toBe("ok");
      expect(await setVendorStatus(env.DB, id, "partner")).toBe(true);
      expect(await getVendor(env.DB, id)).toMatchObject({ payout_address: ADDR, payout_chain: "ARC" });
      await setVendorStatus(env.DB, id, away);
      expect(await getVendor(env.DB, id)).toMatchObject({ status: away, payout_address: null, payout_chain: null });
      await setVendorStatus(env.DB, id, "partner");
      expect(await getVendor(env.DB, id)).toMatchObject({ payout_address: null, payout_chain: null });
    }
  });

  it("stores a payout only for a partner", async () => {
    const id = await vendor({ name: "P", status: "screened" });
    expect(await setVendorPayout(env.DB, id, ADDR, "ARC")).toBe("not_partner");
    expect(await setVendorPayout(env.DB, 999_999, ADDR, "ARC")).toBe("missing");
    await setVendorStatus(env.DB, id, "partner");
    expect(await setVendorPayout(env.DB, id, ADDR, "ARC")).toBe("ok");
    expect(await getVendor(env.DB, id)).toMatchObject({ payout_address: ADDR, payout_chain: "ARC" });
  });
});

describe("vendor jobs", () => {
  it("upserts a proposal until the job is booked", async () => {
    const a = await vendor({ name: "JA" });
    const b = await vendor({ name: "JB" });
    const o = await order();
    expect(await proposeVendorJob(env.DB, job(o, a), new Date(NOW))).toMatchObject({ vendor_id: a, status: "proposed", cost_cents: 120_000 });
    expect(await proposeVendorJob(env.DB, { ...job(o, b), cents: 100_000 })).toMatchObject({ vendor_id: b, cost_cents: 100_000 });
    expect((await vendorJobFor(env.DB, o))?.vendor_id).toBe(b);
    await markJob(env.DB, o, "booked");
    expect(await proposeVendorJob(env.DB, job(o, a))).toBeNull();
    expect((await vendorJobFor(env.DB, o))?.vendor_id).toBe(b);
    expect(await vendorJobFor(env.DB, 999_999)).toBeNull();
  });

  it("marks on_time from the delivery time", async () => {
    const v = await vendor({ name: "JT" });
    const early = await order();
    const late = await order();
    for (const o of [early, late]) {
      await proposeVendorJob(env.DB, job(o, v));
      await markJob(env.DB, o, "booked", new Date("2099-10-01T00:00:00Z"));
    }
    const printed = await markJob(env.DB, early, "printed", new Date("2099-10-07T00:00:00Z"));
    expect(printed).toMatchObject({ status: "printed", on_time: null });
    expect(await markJob(env.DB, early, "delivered", new Date("2099-10-08T10:00:00Z"))).toMatchObject({ status: "delivered", on_time: 1 });
    expect(await markJob(env.DB, late, "delivered", new Date("2099-10-09T10:00:00Z"))).toMatchObject({ status: "delivered", on_time: 0 });
    expect(await vendorScore(env.DB, v)).toEqual({ jobs: 2, onTime: 1 });
    expect(await markJob(env.DB, 999_999, "booked")).toBeNull();
    const edge = await order();
    await proposeVendorJob(env.DB, job(edge, v));
    await markJob(env.DB, edge, "booked");
    expect(await markJob(env.DB, edge, "delivered", new Date("2099-10-08T15:00:30.000Z"))).toMatchObject({ on_time: 0 });
    const exact = await order();
    await proposeVendorJob(env.DB, job(exact, v));
    await markJob(env.DB, exact, "booked");
    expect(await markJob(env.DB, exact, "delivered", new Date("2099-10-08T15:00:00.000Z"))).toMatchObject({ on_time: 1 });
  });
});

describe("obligations for vendors", () => {
  it("carries a vendor id and the waiting status", async () => {
    const v = await vendor({ name: "OV" });
    const ob = await createObligation(env.DB, {
      orderId: null, kind: "printer_cost", token: "USDC", amountUnits: 5_000_000, destination: ADDR, chain: "ARC",
      dueAt: new Date(NOW), sourceRef: "vendor-test:1", status: "waiting", vendorId: v,
    });
    expect(ob).toMatchObject({ status: "waiting", vendor_id: v });
    expect((await getObligation(env.DB, ob.id))?.vendor_id).toBe(v);
    const plain = await createObligation(env.DB, {
      orderId: null, kind: "reserve", token: "USDC", amountUnits: 1, destination: ADDR, chain: "ARC", dueAt: new Date(NOW), sourceRef: "vendor-test:2",
    });
    expect(plain.vendor_id).toBeNull();
  });
});

describe("import re-run against D1", () => {
  const rec = { name: "Roundtrip Print", nip: "5342708006", email: "a@b.pl", methods: ["dtg"], lead_days: {}, vat_status: "active", vat_checked_at: "2026-09-29" };
  const run = async (r: Record<string, unknown>, key: string) => {
    const [row] = toVendorRows("warsaw", [{ ...rec, ...r }]);
    await env.DB.prepare(upsertSql([{ ...row, source_ref: key }])).run();
    return env.DB.prepare("SELECT * FROM vendors WHERE source_ref = ?").bind(key).first<VendorRow>();
  };

  it("keeps partner status and payout, still updates data", async () => {
    const first = await run({}, "rt:partner");
    expect(first).toMatchObject({ status: "screened", payout_address: null });
    await setVendorStatus(env.DB, first!.id, "partner");
    expect(await setVendorPayout(env.DB, first!.id, ADDR, "BASE")).toBe("ok");
    const again = await run({ name: "Renamed Print", email: null, methods: ["screen"] }, "rt:partner");
    expect(again).toMatchObject({ id: first!.id, status: "partner", payout_address: ADDR, payout_chain: "BASE", name: "Renamed Print", email: null, methods: '["screen"]' });
  });

  it("keeps paused status and payout, still updates data", async () => {
    const first = await run({}, "rt:paused");
    await env.DB.prepare("UPDATE vendors SET status = 'paused', payout_address = ?, payout_chain = 'BASE' WHERE id = ?").bind(ADDR, first!.id).run();
    const again = await run({ name: "Renamed Paused" }, "rt:paused");
    expect(again).toMatchObject({ status: "paused", payout_address: ADDR, payout_chain: "BASE", name: "Renamed Paused" });
  });

  it("demotes a screened row to candidate when its email disappears", async () => {
    expect(await run({}, "rt:screened")).toMatchObject({ status: "screened" });
    expect(await run({ email: null }, "rt:screened")).toMatchObject({ status: "candidate" });
  });
});
