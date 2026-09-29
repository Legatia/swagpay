import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { setOrderStatus } from "../src/db";
import {
  addClaim, applyClaims, createPaymentRequest, depositPaid, listPaymentRequests, listUnnotified, markNotified, matchTransfer, recordTransfer,
  type NewTransfer,
} from "../src/payments";
import { insertQuote, newOrderRow } from "./fixtures";

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const transfer = (o: Partial<NewTransfer>): NewTransfer => ({
  txHash: hash(Math.floor(Math.random() * 1e12)), logIndex: 0, blockNumber: 100, token: "USDC",
  from: "0x2222222222222222222222222222222222222222", amountUnits: 1, ...o,
});

async function depositRequest(cents = 25750, tags: number[] = []) {
  const { order } = await newOrderRow();
  const quoteId = await insertQuote(env.DB, order.id, { depositCents: cents });
  const next = [...tags];
  const dueBy = new Date(Date.now() + 48 * 3_600_000);
  const req = await createPaymentRequest(env.DB, { orderId: order.id, quoteId, stage: "deposit", token: "USDC", cents, dueBy }, new Date(), next.length ? () => next.shift()! : undefined);
  return { order, quoteId, req };
}

describe("payment requests", () => {
  it("creates a tagged request", async () => {
    const { req } = await depositRequest(25750, [42]);
    expect(req).toMatchObject({ stage: "deposit", token: "USDC", tag: 42, amount_units: 257500042, paid_units: 0, status: "open", paid_at: null });
    expect(Date.parse(req.due_by)).toBeGreaterThan(Date.now());
  });

  it("picks another tag when the first is taken by an open request of the same token", async () => {
    const a = await depositRequest(10000, [7777]);
    const b = await depositRequest(20000, [7777, 7778]);
    expect(a.req.tag).toBe(7777);
    expect(b.req.tag).toBe(7778);
  });
});

describe("recordTransfer", () => {
  it("credits the exact amount once and marks the request paid", async () => {
    const { order, req } = await depositRequest(25750, [101]);
    const t = transfer({ amountUnits: req.amount_units });
    const first = await recordTransfer(env.DB, t);
    expect(first.kind).toBe("matched");
    if (first.kind !== "matched") return;
    expect(first.request).toMatchObject({ id: req.id, status: "paid", paid_units: req.amount_units });
    expect(first.request.paid_at).toBeTruthy();
    expect(await recordTransfer(env.DB, t)).toEqual({ kind: "duplicate" });
    expect((await listPaymentRequests(env.DB, order.id))[0].paid_units).toBe(req.amount_units);
    expect(await depositPaid(env.DB, order.id)).toBe(true);
  });

  it("matches a short payment by its tag, then the exact remainder", async () => {
    const { req } = await depositRequest(25750, [202]);
    const short = await recordTransfer(env.DB, transfer({ amountUnits: req.amount_units - 1_000_000 }));
    expect(short.kind).toBe("matched");
    if (short.kind === "matched") expect(short.request).toMatchObject({ status: "open", paid_units: req.amount_units - 1_000_000 });
    const rest = await recordTransfer(env.DB, transfer({ amountUnits: 1_000_000 }));
    expect(rest.kind).toBe("matched");
    if (rest.kind === "matched") expect(rest.request).toMatchObject({ id: req.id, status: "paid", paid_units: req.amount_units });
  });

  it("leaves a transfer that matches nothing unmatched", async () => {
    await depositRequest(25750, [303]);
    const odd = await recordTransfer(env.DB, transfer({ amountUnits: 123_450_000 }));
    expect(odd.kind).toBe("unmatched");
    if (odd.kind === "unmatched") expect(odd.transfer.request_id).toBeNull();
    const { req } = await depositRequest(25750, [304]);
    expect((await recordTransfer(env.DB, transfer({ token: "EURC", amountUnits: req.amount_units }))).kind).toBe("unmatched");
  });

  it("credits a claimed hash when the amount matches nothing, and records overpayment", async () => {
    const { req } = await depositRequest(25750, [404]);
    const t = transfer({ amountUnits: 300_000_000 });
    expect(await addClaim(env.DB, req.id, t.txHash)).toBe("stored");
    expect((await matchTransfer(env.DB, { txHash: t.txHash, token: "USDC", amountUnits: 300_000_000 }))).toMatchObject({ request: { id: req.id }, via: "claim" });
    const r = await recordTransfer(env.DB, t);
    expect(r.kind).toBe("matched");
    if (r.kind === "matched") expect(r.request).toMatchObject({ status: "paid", paid_units: 300_000_000 });
  });

  it("refuses a hash already claimed for another request", async () => {
    const a = await depositRequest(10000, [505]);
    const b = await depositRequest(10000, [506]);
    const h = hash(987654321);
    expect(await addClaim(env.DB, a.req.id, h)).toBe("stored");
    expect(await addClaim(env.DB, a.req.id, h.toUpperCase().replace("0X", "0x"))).toBe("stored");
    expect(await addClaim(env.DB, b.req.id, h)).toBe("taken");
  });

  it("credits a transfer claimed after it arrived unmatched, once", async () => {
    const { req } = await depositRequest(25750, [606]);
    const t = transfer({ amountUnits: 250_000_000 });
    expect((await recordTransfer(env.DB, t)).kind).toBe("unmatched");
    await addClaim(env.DB, req.id, t.txHash);
    const applied = await applyClaims(env.DB);
    const mine = applied.filter((o) => o.kind === "matched" && o.request.id === req.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: "matched", request: { id: req.id, paid_units: 250_000_000, status: "open" } });
    expect((await applyClaims(env.DB)).filter((o) => o.kind === "matched" && o.request.id === req.id)).toEqual([]);
    expect(await recordTransfer(env.DB, t)).toEqual({ kind: "duplicate" });
  });
});

describe("notification bookkeeping", () => {
  it("records how a transfer was credited and lists it until notified", async () => {
    const { req } = await depositRequest(25750, [909]);
    const t = transfer({ amountUnits: req.amount_units });
    const r = await recordTransfer(env.DB, t);
    expect(r.kind === "matched" && r.transfer.via).toBe("amount");
    expect((await listUnnotified(env.DB)).some((x) => x.tx_hash === t.txHash.toLowerCase())).toBe(true);
    await markNotified(env.DB, { tx_hash: t.txHash.toLowerCase(), log_index: 0 });
    expect((await listUnnotified(env.DB)).some((x) => x.tx_hash === t.txHash.toLowerCase())).toBe(false);
  });

  it("marks a claim-credited transfer as via claim", async () => {
    const { req } = await depositRequest(25750, [910]);
    const t = transfer({ amountUnits: 250_000_000 });
    await recordTransfer(env.DB, t);
    await addClaim(env.DB, req.id, t.txHash);
    const applied = await applyClaims(env.DB);
    const mine = applied.find((o) => o.kind === "matched" && o.transfer.tx_hash === t.txHash.toLowerCase());
    expect(mine?.kind === "matched" && mine.transfer.via).toBe("claim");
  });
});

describe("invariants", () => {
  const mineOf = (out: Awaited<ReturnType<typeof applyClaims>>, id: number) => out.filter((o) => o.kind === "matched" && o.request.id === id);

  it("does not reuse a tag paid within 30 days", async () => {
    const a = await depositRequest(10000, [4444]);
    expect((await recordTransfer(env.DB, transfer({ amountUnits: a.req.amount_units }))).kind).toBe("matched");
    const b = await depositRequest(10000, [4444, 4445]);
    expect(b.req.tag).toBe(4445);
  });

  it("never lets a claim take an exact payment meant for another request", async () => {
    const v = await depositRequest(10000, [7001]);
    const a = await depositRequest(20000, [7002]);
    const t = transfer({ amountUnits: v.req.amount_units });
    await addClaim(env.DB, a.req.id, t.txHash);
    const r = await recordTransfer(env.DB, t);
    expect(r.kind).toBe("matched");
    if (r.kind === "matched") expect(r).toMatchObject({ via: "amount", request: { id: v.req.id, status: "paid" } });
    expect((await listPaymentRequests(env.DB, a.order.id))[0]).toMatchObject({ paid_units: 0, status: "open" });
  });

  it("leaves an over-sized tagged payment unmatched", async () => {
    const { req } = await depositRequest(10000, [7101]);
    const r = await recordTransfer(env.DB, transfer({ amountUnits: req.amount_units + 1_000_000 }));
    expect(r.kind).toBe("unmatched");
  });

  it("credits once when applyClaims runs twice at once", async () => {
    const { req } = await depositRequest(25750, [7201]);
    const t = transfer({ amountUnits: 250_000_000 });
    expect((await recordTransfer(env.DB, t)).kind).toBe("unmatched");
    await addClaim(env.DB, req.id, t.txHash);
    const [x, y] = await Promise.all([applyClaims(env.DB), applyClaims(env.DB)]);
    expect(mineOf(x, req.id).length + mineOf(y, req.id).length).toBe(1);
    expect((await listPaymentRequests(env.DB, req.order_id))[0].paid_units).toBe(250_000_000);
  });

  it("ignores a claim for a transfer the watcher already credited", async () => {
    const { req } = await depositRequest(25750, [7301]);
    const t = transfer({ amountUnits: req.amount_units });
    expect((await recordTransfer(env.DB, t)).kind).toBe("matched");
    await addClaim(env.DB, req.id, t.txHash);
    expect(mineOf(await applyClaims(env.DB), req.id)).toEqual([]);
    expect((await listPaymentRequests(env.DB, req.order_id))[0].paid_units).toBe(req.amount_units);
  });

  it("records the same log once when two calls race", async () => {
    const { req } = await depositRequest(25750, [7401]);
    const t = transfer({ amountUnits: req.amount_units });
    const results = await Promise.all([recordTransfer(env.DB, t), recordTransfer(env.DB, t)]);
    expect(results.map((r) => r.kind).sort()).toEqual(["duplicate", "matched"]);
    expect((await listPaymentRequests(env.DB, req.order_id))[0].paid_units).toBe(req.amount_units);
  });
});

describe("setOrderStatus", () => {
  it("moves only from the allowed states", async () => {
    const { order } = await newOrderRow();
    expect(await setOrderStatus(env.DB, order.id, ["quoted"], "deposit_pending")).toBe(false);
    expect(await setOrderStatus(env.DB, order.id, ["draft", "quoted"], "quoted")).toBe(true);
    expect(await setOrderStatus(env.DB, order.id, ["quoted"], "deposit_pending")).toBe(true);
  });
});
