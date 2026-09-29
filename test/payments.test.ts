import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { setOrderStatus } from "../src/db";
import {
  addClaim, applyClaims, createPaymentRequest, depositPaid, listPaymentRequests, matchTransfer, recordTransfer,
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
  const req = await createPaymentRequest(env.DB, { orderId: order.id, quoteId, stage: "deposit", token: "USDC", cents }, new Date(), next.length ? () => next.shift()! : undefined);
  return { order, quoteId, req };
}

describe("payment requests", () => {
  it("creates a tagged request", async () => {
    const { req } = await depositRequest(25750, [42]);
    expect(req).toMatchObject({ stage: "deposit", token: "USDC", tag: 42, amount_units: 257500042, paid_units: 0, status: "open", paid_at: null });
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

  it("uses a claimed hash before the amount, and records overpayment", async () => {
    const { req } = await depositRequest(25750, [404]);
    const t = transfer({ amountUnits: 300_000_000 });
    expect(await addClaim(env.DB, req.id, t.txHash)).toBe("stored");
    expect((await matchTransfer(env.DB, { txHash: t.txHash, token: "USDC", amountUnits: 300_000_000 }))?.id).toBe(req.id);
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
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ kind: "matched", request: { id: req.id, paid_units: 250_000_000, status: "open" } });
    expect(await applyClaims(env.DB)).toEqual([]);
    expect(await recordTransfer(env.DB, t)).toEqual({ kind: "duplicate" });
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
