import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createOrder } from "../src/db";
import { IntakeSchema } from "../src/intake";
import { createObligation, getObligation } from "../src/treasury";
import {
  cityFromPlace, getVendor, listVendors, markJob, proposeVendorJob, setVendorPayout, setVendorStatus, suggestVendors, vendorJobFor, vendorScore,
  type VendorStatus,
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
const job = (orderId: number, vendorId: number, deliverBy = "2099-10-08T17:00") => ({ orderId, vendorId, deliverBy, currency: "PLN", cents: 120_000 });
const ADDR = "0x" + "a".repeat(40);

describe("cityFromPlace", () => {
  it("finds the four cities by name or alias", () => {
    expect(cityFromPlace("Kolektyw3, Koszykowa 54, Warszawa")).toBe("Warsaw");
    expect(cityFromPlace("MEO Arena, Lisboa")).toBe("Lisbon");
    expect(cityFromPlace("Olympia London")).toBe("London");
    expect(cityFromPlace("Jio World Centre, BKC, Mumbai")).toBe("Mumbai");
    expect(cityFromPlace("Berlin")).toBeNull();
    expect(cityFromPlace("Londonderry")).toBeNull();
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
