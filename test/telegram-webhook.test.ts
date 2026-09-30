import { SELF, env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { OrderAgent } from "../src/agent/order-agent";
import type { TreasuryAgent } from "../src/agent/treasury-agent";
import { createOrder, getOrderById } from "../src/db";
import { createEscalation, getEscalation, listEscalations } from "../src/escalations";
import { NBP_BASE } from "../src/fx";
import { IntakeSchema } from "../src/intake";
import { listPaymentRequests } from "../src/payments";
import { HELP, handleTelegram, parseCostArgs } from "../src/telegram-webhook";
import type { TelegramClient } from "../src/telegram";
import { createObligation, getObligation, queuePayout, recordPayoutResult } from "../src/treasury";
import { getVendor, markJob, proposeVendorJob, vendorJobFor, type VendorStatus } from "../src/vendors";
import { completeSpec, insertQuote, newOrderRow } from "./fixtures";
import { msg, scriptedModel, toolUse } from "./helpers";

const intake = IntakeSchema.parse({
  eventName: "Builders meetup", eventDate: "2099-10-08", deliverBy: "2099-10-08T17:00",
  deliveryPlace: "Kolektyw3, Koszykowa 54, Warsaw", contactName: "Ana", contactEmail: "ana@example.com",
  request: "60 black tees with our logo and 500 stickers",
});

function fakeTelegram() {
  const sent: string[] = [];
  const answered: string[] = [];
  const telegram: TelegramClient = {
    async send(_chat, text) { sent.push(text); return 1; },
    async answerCallback(id, text) { answered.push(`${id}:${text}`); },
  };
  return { sent, answered, telegram };
}

const update = (body: unknown, secret = "test-secret") =>
  new Request("https://swagpay.test/api/telegram", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify(body),
  });
const fromOwner = (text: string) => ({ message: { chat: { id: 42 }, text } });

let vendorSeq = 0;
async function addVendor(o: { name: string; status: VendorStatus; city?: string; methods?: string[]; email?: string }): Promise<number> {
  const at = "2099-01-01T10:00:00.000Z";
  const res = await env.DB.prepare(
    "INSERT INTO vendors (name, city, country, methods, email, status, source_ref, created_at, updated_at) VALUES (?, ?, 'PL', ?, ?, ?, ?, ?, ?)",
  ).bind(o.name, o.city ?? "Warsaw", JSON.stringify(o.methods ?? ["screen"]), o.email ?? null, o.status, `tg:${++vendorSeq}`, at, at).run();
  return res.meta.last_row_id as number;
}

/** A fake NBP answering every code with `mid`; records the URLs asked for. */
function nbp(mid: number, seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return Response.json({ rates: [{ mid, effectiveDate: "2026-10-01" }] });
  }) as typeof fetch;
}
const noFetch = (async () => { throw new Error("fetch must not be called"); }) as typeof fetch;

const USAGE = "Usage: /cost <id> <amount> [PLN|EUR|GBP|USD|INR] [v<printer #>] [note]";

describe("parseCostArgs", () => {
  it("reads the amount, then an optional currency and printer in either order, then the note", () => {
    expect(parseCostArgs(["1200,50"])).toEqual({ amount: 1200.5, currency: "PLN", vendorId: null, note: null });
    expect(parseCostArgs(["350", "EUR"])).toEqual({ amount: 350, currency: "EUR", vendorId: null, note: null });
    expect(parseCostArgs(["350", "eur", "v3", "rush"])).toEqual({ amount: 350, currency: "EUR", vendorId: 3, note: "rush" });
    expect(parseCostArgs(["350", "V3", "gbp", "two", "colours"])).toEqual({ amount: 350, currency: "GBP", vendorId: 3, note: "two colours" });
    expect(parseCostArgs(["v3", "1000"])).toEqual({ amount: 1000, currency: "PLN", vendorId: 3, note: null });
    expect(parseCostArgs(["INR", "v12", "20000", "Mumbai"])).toEqual({ amount: 20000, currency: "INR", vendorId: 12, note: "Mumbai" });
  });

  it("treats a word that isn't a currency or printer as the start of the note", () => {
    expect(parseCostArgs(["350", "XYZ"])).toEqual({ amount: 350, currency: "PLN", vendorId: null, note: "XYZ" });
    expect(parseCostArgs(["350", "Drukarnia", "EUR", "v3"])).toEqual({ amount: 350, currency: "PLN", vendorId: null, note: "Drukarnia EUR v3" });
  });

  it("still catches an amount written with a thousands separator", () => {
    expect(parseCostArgs(["1", "200,50", "Drukarnia"], 7)).toEqual({ error: "Did you mean 1200,50? Write the amount without spaces, e.g. /cost 7 1200.50" });
    expect(parseCostArgs(["EUR", "v3", "12", "500"], 7)).toEqual({ error: "Did you mean 12500? Write the amount without spaces, e.g. /cost 7 1200.50" });
  });

  it("refuses what it can't read safely", () => {
    expect(parseCostArgs([])).toEqual({ error: USAGE });
    expect(parseCostArgs(["12x"])).toEqual({ error: USAGE });
    expect(parseCostArgs(["0"])).toEqual({ error: USAGE });
    expect(parseCostArgs(["EUR"])).toEqual({ error: USAGE });
    expect(parseCostArgs(["drukarnia", "350"])).toEqual({ error: USAGE });
    expect(parseCostArgs(["350", "EUR", "usd"])).toEqual({ error: "Give one currency and one printer at most. Nothing was recorded." });
    expect(parseCostArgs(["v3", "350", "v4"])).toEqual({ error: "Give one currency and one printer at most. Nothing was recorded." });
  });

  it("refuses a currency it can't convert, however it's written, instead of reading it as PLN", () => {
    const refused = (what: string) => ({
      error: `${what} can't be converted here: give the cost in PLN, EUR, GBP, USD or INR. Nothing was recorded. If it's part of the note, put PLN before it.`,
    });
    expect(parseCostArgs(["350", "CHF", "rush"])).toEqual(refused("CHF"));
    expect(parseCostArgs(["350", "v3", "chf"])).toEqual(refused("CHF"));
    for (const w of ["€", "$", "£", "₹", "zł", "zl", "ZŁ", "euro", "Euros", "dollar", "dollars", "pound", "pounds", "rupee", "rupees", "złoty", "zloty", "zł."]) {
      expect(parseCostArgs(["350", w]), w).toEqual(refused(w));
    }
    expect(parseCostArgs(["350", "all", "colours"])).toEqual(refused("ALL"));
    // Once the currency is named, the rest is the note.
    expect(parseCostArgs(["350", "PLN", "all", "colours"])).toEqual({ amount: 350, currency: "PLN", vendorId: null, note: "all colours" });
    expect(parseCostArgs(["350", "XYZ"])).toEqual({ amount: 350, currency: "PLN", vendorId: null, note: "XYZ" });
  });
});

async function orderWithEscalation() {
  const { order } = await createOrder(env.DB, intake, new Date("2099-01-01T10:00:00Z"));
  const stub = await getAgentByName(env.OrderAgent, order.instance);
  await stub.init(order.id, intake);
  const e = await createEscalation(env.DB, { orderId: order.id, kind: "approval", summary: "Approve: banner", payload: {} });
  return { order, stub, e };
}

describe("Telegram webhook", () => {
  async function paidDepositOrder(o: { priceCents?: number; depositCents?: number } = {}) {
    const { order } = await newOrderRow();
    const stub = await getAgentByName(env.OrderAgent, order.instance);
    await stub.init(order.id, intake);
    const quoteId = await insertQuote(env.DB, order.id, { priceCents: o.priceCents ?? 38000, depositCents: o.depositCents ?? 25750 });
    await env.DB.prepare("UPDATE quotes SET status = 'accepted' WHERE id = ?").bind(quoteId).run();
    await env.DB.prepare("UPDATE orders SET status = 'deposit_paid' WHERE id = ?").bind(order.id).run();
    return { order, stub, quoteId };
  }

  it("/printed sends the balance request once", async () => {
    const { order, stub } = await paidDepositOrder();
    const t = fakeTelegram();
    await handleTelegram(update(fromOwner(`/printed ${order.id}`)), env, t);
    expect(t.sent[0]).toMatch(new RegExp(`^Order ${order.id}: printed; balance request #\\d+ for 122\\.50\\d{4} USDC is on the order page\\.$`));
    const requests = (await listPaymentRequests(env.DB, order.id)).filter((r) => r.stage === "balance");
    expect(requests).toHaveLength(1);
    expect(Math.floor(requests[0].amount_units / 10_000)).toBe(12250);
    expect((await getOrderById(env.DB, order.id))?.status).toBe("balance_pending");
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      expect(agent.sql<{ text: string }>`SELECT text FROM inbox`.map((r) => r.text).join("\n")).toContain(`Balance request #${requests[0].id}`);
    });
    await handleTelegram(update(fromOwner(`/printed ${order.id}`)), env, t);
    expect(t.sent[1]).toBe(`Order ${order.id} is balance_pending; /printed works once the deposit is paid.`);
    expect((await listPaymentRequests(env.DB, order.id)).filter((r) => r.stage === "balance")).toHaveLength(1);
  });

  it("/printed with nothing left to pay marks the order paid", async () => {
    const { order } = await paidDepositOrder({ priceCents: 25750, depositCents: 25750 });
    const t = fakeTelegram();
    await handleTelegram(update(fromOwner(`/printed ${order.id}`)), env, t);
    expect(t.sent[0]).toBe(`Order ${order.id}: printed; nothing more is due.`);
    expect((await getOrderById(env.DB, order.id))?.status).toBe("balance_paid");
  });

  describe("/printed with a partner printer's milestones", () => {
    const VADDR = "0x" + "ab".repeat(20);
    const treasuryInbox = async () => runInDurableObject(await getAgentByName(env.TreasuryAgent, "treasury"), async (agent: TreasuryAgent) =>
      agent.sql<{ text: string }>`SELECT text FROM inbox`.map((r) => r.text).join("\n"));
    const setObligationStatusDirect = (id: number, status: string) => env.DB.prepare("UPDATE obligations SET status = ? WHERE id = ?").bind(status, id).run();
    /** A deposit-paid order booked with a partner printer: milestone 1 open, milestone 2 waiting. */
    async function bookedWithPartner(o: { priceCents?: number; depositCents?: number } = {}) {
      const paid = await paidDepositOrder(o);
      const v = await addVendor({ name: "Drukarnia Partner", status: "partner" });
      await env.DB.prepare("UPDATE vendors SET payout_address = ?, payout_chain = 'BASE' WHERE id = ?").bind(VADDR, v).run();
      await proposeVendorJob(env.DB, { orderId: paid.order.id, vendorId: v, deliverBy: paid.order.deliver_by, currency: "PLN", cents: 100_000 });
      await markJob(env.DB, paid.order.id, "booked");
      const base = { orderId: paid.order.id, kind: "printer_cost" as const, token: "USDC" as const, destination: VADDR, chain: "BASE", dueAt: new Date(), vendorId: v };
      const m1 = await createObligation(env.DB, { ...base, amountUnits: 128_750_000, sourceRef: `printer_cost:quote:${paid.quoteId}:m1` });
      const m2 = await createObligation(env.DB, { ...base, amountUnits: 128_750_000, sourceRef: `printer_cost:quote:${paid.quoteId}:m2`, status: "waiting" });
      return { ...paid, v, m1, m2 };
    }

    it("opens this order's waiting milestone, marks the job printed and tells the treasury", async () => {
      const { order, v, m1, m2 } = await bookedWithPartner();
      // Another order's waiting milestone, and a waiting obligation of this order that pays no printer: both stay waiting.
      const other = await bookedWithPartner();
      const notPrinter = await createObligation(env.DB, {
        orderId: order.id, kind: "printer_cost", token: "USDC", amountUnits: 1_000_000, destination: "0x3333333333333333333333333333333333333333", chain: "MATIC",
        dueAt: new Date(), sourceRef: `t:${crypto.randomUUID()}`, status: "waiting",
      });
      const t = fakeTelegram();
      await handleTelegram(update(fromOwner(`/printed ${order.id}`)), env, t);
      expect(t.sent[0]).toMatch(new RegExp(`^Order ${order.id}: printed; balance request #\\d+ for 122\\.50\\d{4} USDC is on the order page\\. Printer #${v}'s milestone #${m2.id} \\(128\\.750000 USDC\\) is now due; the treasury pays it\\.$`));
      expect(await getObligation(env.DB, m2.id)).toMatchObject({ status: "open", approved_by: null });
      expect((await getObligation(env.DB, m1.id))?.status).toBe("open");
      expect((await getObligation(env.DB, other.m2.id))?.status).toBe("waiting");
      expect((await getObligation(env.DB, notPrinter.id))?.status).toBe("waiting");
      const job = await vendorJobFor(env.DB, order.id);
      expect(job).toMatchObject({ vendor_id: v, status: "printed" });
      expect(job?.printed_at).not.toBeNull();
      expect((await vendorJobFor(env.DB, other.order.id))?.status).toBe("booked");
      const inbox = await treasuryInbox();
      expect(inbox).toContain(`Order ${order.id} printed: milestone obligation #${m2.id} (128.750000 USDC to printer #${v}) is now due.`);
      expect(inbox).not.toContain(`obligation #${other.m2.id} `);
      expect(inbox).not.toContain(`obligation #${notPrinter.id} `);
    });

    it("opens the milestone when nothing more is due, and on a repeated /printed after the release failed", async () => {
      const none = await bookedWithPartner({ priceCents: 25750, depositCents: 25750 });
      const t = fakeTelegram();
      await handleTelegram(update(fromOwner(`/printed ${none.order.id}`)), env, t);
      expect(t.sent[0]).toBe(`Order ${none.order.id}: printed; nothing more is due. Printer #${none.v}'s milestone #${none.m2.id} (128.750000 USDC) is now due; the treasury pays it.`);
      expect((await getObligation(env.DB, none.m2.id))?.status).toBe("open");
      expect((await vendorJobFor(env.DB, none.order.id))?.status).toBe("printed");

      // The order moved on, but its milestone is still waiting (the first /printed stopped after the status move).
      const stuck = await bookedWithPartner();
      await env.DB.prepare("UPDATE orders SET status = 'balance_pending' WHERE id = ?").bind(stuck.order.id).run();
      await handleTelegram(update(fromOwner(`/printed ${stuck.order.id}`)), env, t);
      expect(t.sent[1]).toBe(`Order ${stuck.order.id} was already printed. Printer #${stuck.v}'s milestone #${stuck.m2.id} (128.750000 USDC) is now due; the treasury pays it.`);
      expect((await getObligation(env.DB, stuck.m2.id))?.status).toBe("open");
      expect((await vendorJobFor(env.DB, stuck.order.id))?.status).toBe("printed");
      expect(await listPaymentRequests(env.DB, stuck.order.id)).toEqual([]);
      // Once released, a repeat is the usual answer.
      await handleTelegram(update(fromOwner(`/printed ${stuck.order.id}`)), env, t);
      expect(t.sent[2]).toBe(`Order ${stuck.order.id} is balance_pending; /printed works once the deposit is paid.`);
    });

    it("still answers when the release fails, and says to send /printed again", async () => {
      const { order, m2 } = await bookedWithPartner();
      // D1 fails only for the waiting-milestone lookup.
      const db = env.DB;
      const flaky = new Proxy(db, {
        get(target, key) {
          if (key === "prepare") {
            return (sql: string) => {
              if (sql.includes("vendor_id IS NOT NULL")) throw new Error("D1 unavailable");
              return target.prepare(sql);
            };
          }
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const t = fakeTelegram();
      await handleTelegram(update(fromOwner(`/printed ${order.id}`)), ({ ...env, DB: flaky }) as Env, t);
      expect(t.sent[0]).toMatch(new RegExp(`^Order ${order.id}: printed; balance request #\\d+ for .* is on the order page\\. The printer's second milestone wasn't released; send /printed ${order.id} again\\.$`));
      expect((await getObligation(env.DB, m2.id))?.status).toBe("waiting");
      expect((await getOrderById(env.DB, order.id))?.status).toBe("balance_pending");
      await handleTelegram(update(fromOwner(`/printed ${order.id}`)), env, t);
      expect(t.sent[1]).toContain(`Order ${order.id} was already printed. `);
      expect((await getObligation(env.DB, m2.id))?.status).toBe("open");
    });

    it("rejecting an over-limit or failed-payout escalation on milestone 1 leaves milestone 2 waiting", async () => {
      const limit = await bookedWithPartner();
      await setObligationStatusDirect(limit.m1.id, "escalated");
      const overLimit = await createEscalation(env.DB, { orderId: null, kind: "approval", summary: "Treasury: over the limit", payload: { obligationId: limit.m1.id } });
      const failed = await bookedWithPartner();
      const payout = (await queuePayout(env.DB, failed.m1))!;
      await recordPayoutResult(env.DB, payout.id, { status: "failed", error: "RPC timeout" });
      const failedPayout = await createEscalation(env.DB, { orderId: null, kind: "approval", summary: "Payout failed", payload: { obligationId: failed.m1.id, payoutId: payout.id } });
      const t = fakeTelegram();
      await handleTelegram(update(fromOwner(`/reject ${overLimit.id}`)), env, t);
      await handleTelegram(update(fromOwner(`/reject ${failedPayout.id}`)), env, t);
      expect((await getObligation(env.DB, limit.m1.id))?.status).toBe("settled");
      expect((await getObligation(env.DB, failed.m1.id))?.status).toBe("settled");
      expect((await getObligation(env.DB, limit.m2.id))?.status).toBe("waiting");
      expect((await getObligation(env.DB, failed.m2.id))?.status).toBe("waiting");
    });

    it("never opens a milestone before the deposit is paid", async () => {
      const early = await bookedWithPartner();
      await env.DB.prepare("UPDATE orders SET status = 'deposit_pending' WHERE id = ?").bind(early.order.id).run();
      const t = fakeTelegram();
      await handleTelegram(update(fromOwner(`/printed ${early.order.id}`)), env, t);
      expect(t.sent[0]).toBe(`Order ${early.order.id} is deposit_pending; /printed works once the deposit is paid.`);
      expect((await getObligation(env.DB, early.m2.id))?.status).toBe("waiting");
      expect((await vendorJobFor(env.DB, early.order.id))?.status).toBe("booked");
    });
  });

  it("rejects a wrong secret and ignores other chats", async () => {
    const t = fakeTelegram();
    expect((await handleTelegram(update(fromOwner("/open"), "nope"), env, t)).status).toBe(401);
    const { e } = await orderWithEscalation();
    const res = await handleTelegram(update({ message: { chat: { id: 7 }, text: `/approve ${e.id}` } }), env, t);
    expect(res.status).toBe(200);
    expect(t.sent).toEqual([]);
    expect((await getEscalation(env.DB, e.id))?.status).toBe("open");
  });

  it("is off without a webhook secret", async () => {
    const off = { ...env, TELEGRAM_WEBHOOK_SECRET: "" } as Env;
    expect((await handleTelegram(update(fromOwner("/open")), off, fakeTelegram())).status).toBe(404);
  });

  it("lists open escalations", async () => {
    const { e } = await orderWithEscalation();
    const t = fakeTelegram();
    await handleTelegram(update(fromOwner("/open")), env, t);
    expect(t.sent[0]).toContain(`#${e.id}`);
    expect(t.sent[0]).toContain("Approve: banner");
  });

  it("approves with a note, tells the agent, and refuses a second decision", async () => {
    const { stub, e } = await orderWithEscalation();
    const t = fakeTelegram();
    await handleTelegram(update(fromOwner(`/approve ${e.id} fine for this event`)), env, t);
    expect(t.sent[0]).toBe(`#${e.id} approved.`);
    expect(await getEscalation(env.DB, e.id)).toMatchObject({ status: "approved", decision_note: "fine for this event" });
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      const inbox = agent.sql<{ text: string }>`SELECT text FROM inbox`.map((r) => r.text).join("\n");
      expect(inbox).toContain(`Owner decision on escalation #${e.id} (summary: "Approve: banner"): approved.`);
      expect(inbox).toContain('Note from the owner: "fine for this event"');
    });
    expect((await getEscalation(env.DB, e.id))?.delivered_at).toBeTruthy();
    await handleTelegram(update(fromOwner(`/reject ${e.id}`)), env, t);
    expect(t.sent[1]).toBe(`#${e.id} is already approved.`);
  });

  it("re-sends a decision, and refuses strict-id violations", async () => {
    const { stub, e } = await orderWithEscalation();
    const t = fakeTelegram();
    await handleTelegram(update(fromOwner(`/resend ${e.id}`)), env, t);
    expect(t.sent[0]).toBe(`#${e.id} is still open.`);
    await handleTelegram(update(fromOwner(`/approve ${e.id}`)), env, t);
    expect(t.sent[1]).toBe(`#${e.id} approved.`);
    await handleTelegram(update(fromOwner(`/resend ${e.id}`)), env, t);
    expect(t.sent[2]).toBe(`#${e.id} was already delivered to the agent.`);
    await env.DB.prepare("UPDATE escalations SET delivered_at = NULL WHERE id = ?").bind(e.id).run();
    await handleTelegram(update(fromOwner(`/resend ${e.id}`)), env, t);
    expect(t.sent[3]).toBe(`#${e.id} re-sent to the agent (approved).`);
    expect((await getEscalation(env.DB, e.id))?.delivered_at).toBeTruthy();
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      const inbox = agent.sql<{ text: string }>`SELECT text FROM inbox`.map((r) => r.text).join("\n");
      expect(inbox.split(`Owner decision on escalation #${e.id}`).length - 1).toBe(2);
    });
    await handleTelegram(update(fromOwner("/approve 1e2")), env, t);
    expect(t.sent[4]).toBe("Usage: /approve <id> [note]");
  });

  it("handles the Reject button", async () => {
    const { e } = await orderWithEscalation();
    const t = fakeTelegram();
    await handleTelegram(update({ callback_query: { id: "cb9", data: `esc:${e.id}:reject`, message: { chat: { id: 42 } } } }), env, t);
    expect((await getEscalation(env.DB, e.id))?.status).toBe("rejected");
    expect(t.answered).toEqual([`cb9:#${e.id} rejected.`]);
    expect(t.sent).toEqual([`#${e.id} rejected.`]);
  });

  it("says a system notice was acknowledged", async () => {
    const { order } = await orderWithEscalation();
    const e = await createEscalation(env.DB, { orderId: order.id, kind: "system", summary: "Order failed", payload: {} });
    const t = fakeTelegram();
    await handleTelegram(update({ callback_query: { id: "cb1", data: `esc:${e.id}:approve`, message: { chat: { id: 42 } } } }), env, t);
    expect(t.answered).toEqual([`cb1:#${e.id} acknowledged.`]);
    expect(t.sent).toEqual([`#${e.id} acknowledged.`]);
    await handleTelegram(update(fromOwner(`/approve ${e.id}`)), env, t);
    expect(t.sent[1]).toBe(`#${e.id} is already acknowledged.`);
  });

  it("ignores buttons from other chats and crafted button data", async () => {
    const { e } = await orderWithEscalation();
    const t = fakeTelegram();
    const other = await handleTelegram(update({ callback_query: { id: "cb2", data: `esc:${e.id}:approve`, message: { chat: { id: 7 } } } }), env, t);
    expect(other.status).toBe(200);
    expect(t.answered).toEqual([]);
    expect(t.sent).toEqual([]);
    expect((await getEscalation(env.DB, e.id))?.status).toBe("open");
    await handleTelegram(update({ callback_query: { id: "cb3", data: `esc:${e.id}:approved`, message: { chat: { id: 42 } } } }), env, t);
    expect(t.answered).toEqual(["cb3:Unknown button."]);
    expect((await getEscalation(env.DB, e.id))?.status).toBe("open");
  });

  it("lists decisions the agent hasn't heard under /open", async () => {
    const { e } = await orderWithEscalation();
    const t = fakeTelegram();
    await handleTelegram(update(fromOwner(`/approve ${e.id}`)), env, t);
    await env.DB.prepare("UPDATE escalations SET delivered_at = NULL WHERE id = ?").bind(e.id).run();
    await handleTelegram(update(fromOwner("/open")), env, t);
    expect(t.sent[1]).toContain(`#${e.id} approved — agent not told yet: /resend ${e.id}`);
  });

  it("keeps a decision the agent couldn't hear, and says how to retry", async () => {
    const { stub, e } = await orderWithEscalation();
    const t = fakeTelegram();
    const unreachable = { idFromName() { throw new Error("agent unreachable"); } } as unknown as Env["OrderAgent"];
    const down = ({ ...env, OrderAgent: unreachable }) as Env;
    await handleTelegram(update(fromOwner(`/approve ${e.id}`)), down, t);
    expect(t.sent[0]).toBe(`#${e.id} approved, but the agent could not be told. Send /resend ${e.id} to retry.`);
    expect(await getEscalation(env.DB, e.id)).toMatchObject({ status: "approved", delivered_at: null });
    await handleTelegram(update(fromOwner(`/reject ${e.id}`)), down, t);
    expect(t.sent[1]).toBe(`#${e.id} is already approved. The agent has not been told yet: send /resend ${e.id}.`);
    await handleTelegram(update(fromOwner(`/resend ${e.id}`)), down, t);
    expect(t.sent[2]).toBe(`#${e.id}: the agent could not be told. Try /resend ${e.id} again later.`);
    await handleTelegram(update(fromOwner(`/resend ${e.id}`)), env, t);
    expect(t.sent[3]).toBe(`#${e.id} re-sent to the agent (approved).`);
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      const inbox = agent.sql<{ text: string }>`SELECT text FROM inbox`.map((r) => r.text).join("\n");
      expect(inbox.split(`Owner decision on escalation #${e.id}`).length - 1).toBe(1);
    });
  });

  it("offers /resend for an undelivered decision that has no order (a treasury escalation)", async () => {
    const e = await createEscalation(env.DB, { orderId: null, kind: "agent", summary: "Treasury: wallet low", payload: { treasury: true } });
    const t = fakeTelegram();
    const unreachable = { idFromName() { throw new Error("agent unreachable"); } } as unknown as Env["TreasuryAgent"];
    const down = ({ ...env, TreasuryAgent: unreachable }) as Env;
    await handleTelegram(update(fromOwner(`/approve ${e.id}`)), down, t);
    expect(t.sent[0]).toBe(`#${e.id} approved, but the agent could not be told. Send /resend ${e.id} to retry.`);
    await handleTelegram(update(fromOwner(`/reject ${e.id}`)), down, t);
    expect(t.sent[1]).toBe(`#${e.id} is already approved. The agent has not been told yet: send /resend ${e.id}.`);
    await handleTelegram(update(fromOwner(`/resend ${e.id}`)), env, t);
    expect(t.sent[2]).toBe(`#${e.id} re-sent to the agent (approved).`);
  });

  it("answers a failing command instead of erroring", async () => {
    const { order } = await orderWithEscalation();
    const t = fakeTelegram();
    const unreachable = { idFromName() { throw new Error("agent unreachable"); } } as unknown as Env["OrderAgent"];
    const res = await handleTelegram(update(fromOwner(`/order ${order.id}`)), ({ ...env, OrderAgent: unreachable }) as Env, t);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(t.sent).toEqual(["Something went wrong: agent unreachable"]);
  });

  it("shows an order's status and answers anything else with help", async () => {
    const { order } = await orderWithEscalation();
    const t = fakeTelegram();
    await handleTelegram(update(fromOwner(`/order ${order.id}`)), env, t);
    expect(t.sent[0]).toContain(`Order ${order.id} · Builders meetup`);
    expect(t.sent[0]).toContain("Still missing:");
    await handleTelegram(update(fromOwner("hello")), env, t);
    expect(t.sent[1]).toContain("/approve <id> [note]");
    await handleTelegram(update(fromOwner("/approve abc")), env, t);
    expect(t.sent[2]).toBe("Usage: /approve <id> [note]");
  });

  it("is routed by the Worker", async () => {
    const res = await SELF.fetch(update(fromOwner("/help")));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  async function orderWithCostRequest() {
    const { order } = await createOrder(env.DB, intake, new Date("2099-01-01T10:00:00Z"));
    const stub = await getAgentByName(env.OrderAgent, order.instance);
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      agent.telegramOverride = { async send() { return 1; }, async answerCallback() {} };
      await agent.init(order.id, intake);
      agent.sql`INSERT OR REPLACE INTO spec (id, json) VALUES (1, ${JSON.stringify(completeSpec)})`;
      agent.modelOverride = scriptedModel([msg([toolUse("request_printer_cost", { reason: "order complete" })], "tool_use"), msg([], "end_turn")]);
      await agent.processTurn();
    });
    const e = (await listEscalations(env.DB, { status: "open" })).find((x) => x.order_id === order.id && x.kind === "cost")!;
    return { order, stub, e };
  }

  it("records a cost with /cost and tells the agent", async () => {
    const { order, stub, e } = await orderWithCostRequest();
    const t = fakeTelegram();
    await handleTelegram(update(fromOwner(`/cost ${e.id} 1200,50 Drukarnia X`)), env, t);
    expect(t.sent[0]).toBe(`#${e.id}: 1200.50 PLN recorded for order ${order.id}.`);
    expect(await getEscalation(env.DB, e.id)).toMatchObject({ status: "approved", decision_note: "1200.50 PLN; Drukarnia X" });
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      expect(agent.sql<{ cost_grosze: number }>`SELECT cost_grosze FROM printer_costs`[0].cost_grosze).toBe(120050);
    });
    await handleTelegram(update(fromOwner(`/cost ${e.id} 900`)), env, t);
    expect(t.sent[1]).toBe(`#${e.id} is already approved.`);
  });

  it("asks again instead of recording an amount written with a thousands separator", async () => {
    const { e, stub } = await orderWithCostRequest();
    const t = fakeTelegram();
    await handleTelegram(update(fromOwner(`/cost ${e.id} 1 200,50 Drukarnia X`)), env, t);
    await handleTelegram(update(fromOwner(`/cost ${e.id} 12 500`)), env, t);
    expect(t.sent).toEqual([
      `Did you mean 1200,50? Write the amount without spaces, e.g. /cost ${e.id} 1200.50`,
      `Did you mean 12500? Write the amount without spaces, e.g. /cost ${e.id} 1200.50`,
    ]);
    expect((await getEscalation(env.DB, e.id))?.status).toBe("open");
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      expect(agent.sql<{ n: number }>`SELECT COUNT(*) AS n FROM printer_costs`[0].n).toBe(0);
    });
  });

  it("refuses bad amounts, other kinds and a plain approve on a cost request", async () => {
    const { e } = await orderWithCostRequest();
    const other = await orderWithEscalation();
    const t = fakeTelegram();
    await handleTelegram(update(fromOwner(`/cost ${e.id} 12x`)), env, t);
    await handleTelegram(update(fromOwner(`/cost ${e.id} 0`)), env, t);
    await handleTelegram(update(fromOwner(`/cost ${other.e.id} 100`)), env, t);
    await handleTelegram(update(fromOwner(`/approve ${e.id}`)), env, t);
    expect(t.sent).toEqual([
      USAGE,
      USAGE,
      `#${other.e.id} is not a cost request.`,
      `#${e.id} needs a price: /cost ${e.id} <amount> [PLN|EUR|GBP|USD|INR] [v<printer #>] [note]`,
    ]);
    expect((await getEscalation(env.DB, e.id))?.status).toBe("open");
  });

  it("/cost in EUR converts at the NBP mid rate and proposes the printer's job", async () => {
    const { order, stub, e } = await orderWithCostRequest();
    const v = await addVendor({ name: "Drukarnia Euro", status: "screened" });
    const t = fakeTelegram();
    const seen: string[] = [];
    await handleTelegram(update(fromOwner(`/cost ${e.id} 350 EUR v${v} rush job`)), env, { telegram: t.telegram, fetch: nbp(4.2553, seen) });
    expect(seen).toEqual([`${NBP_BASE}/eur/?format=json`]);
    expect(t.sent).toEqual([`#${e.id}: 1489.36 PLN (350.00 EUR at 4.2553) recorded for order ${order.id}; printer #${v} Drukarnia Euro.`]);
    expect(await getEscalation(env.DB, e.id)).toMatchObject({
      status: "approved",
      decision_note: `1489.36 PLN; 350.00 EUR at 4.2553 PLN (NBP 2026-10-01); printer #${v} Drukarnia Euro; rush job`,
    });
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      expect(agent.sql<{ cost_grosze: number }>`SELECT cost_grosze FROM printer_costs`[0].cost_grosze).toBe(148936);
      const inbox = agent.sql<{ text: string }>`SELECT text FROM inbox`.map((r) => r.text).join("\n");
      expect(inbox).toContain(`Printer cost from the owner (escalation #${e.id}): 1489.36 PLN gross`);
      expect(inbox).toContain(`Owner's note: "350.00 EUR at 4.2553 PLN (NBP 2026-10-01); printer #${v} Drukarnia Euro; rush job".`);
    });
    expect(await vendorJobFor(env.DB, order.id)).toMatchObject({
      vendor_id: v, status: "proposed", cost_currency: "EUR", cost_cents: 35000, deliver_by: order.deliver_by,
    });
  });

  it("/cost in INR without a printer converts and proposes no job", async () => {
    const { order, e } = await orderWithCostRequest();
    const t = fakeTelegram();
    const seen: string[] = [];
    await handleTelegram(update(fromOwner(`/cost ${e.id} 0.01 INR`)), env, { telegram: t.telegram, fetch: nbp(0.0437) });
    expect((await getEscalation(env.DB, e.id))?.status).toBe("open");
    await handleTelegram(update(fromOwner(`/cost ${e.id} 20000 inr`)), env, { telegram: t.telegram, fetch: nbp(0.0437, seen) });
    expect(seen).toEqual([`${NBP_BASE}/inr/?format=json`]);
    expect(t.sent).toEqual([
      "That's less than 0.01 PLN; nothing was recorded.",
      `#${e.id}: 874.00 PLN (20000.00 INR at 0.0437) recorded for order ${order.id}.`,
    ]);
    expect((await getEscalation(env.DB, e.id))?.decision_note).toBe("874.00 PLN; 20000.00 INR at 0.0437 PLN (NBP 2026-10-01)");
    expect(await vendorJobFor(env.DB, order.id)).toBeNull();
  });

  it("/cost in PLN with a printer doesn't ask NBP", async () => {
    const { order, stub, e } = await orderWithCostRequest();
    const v = await addVendor({ name: "Drukarnia Partner", status: "partner" });
    const t = fakeTelegram();
    await handleTelegram(update(fromOwner(`/cost ${e.id} v${v} 1000`)), env, { telegram: t.telegram, fetch: noFetch });
    expect(t.sent).toEqual([`#${e.id}: 1000.00 PLN recorded for order ${order.id}; printer #${v} Drukarnia Partner.`]);
    expect((await getEscalation(env.DB, e.id))?.decision_note).toBe(`1000.00 PLN; printer #${v} Drukarnia Partner`);
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      expect(agent.sql<{ cost_grosze: number }>`SELECT cost_grosze FROM printer_costs`[0].cost_grosze).toBe(100000);
    });
    expect(await vendorJobFor(env.DB, order.id)).toMatchObject({ vendor_id: v, cost_currency: "PLN", cost_cents: 100000 });
  });

  it("records nothing when the NBP rate can't be had, and says so", async () => {
    const { order, stub, e } = await orderWithCostRequest();
    const v = await addVendor({ name: "Drukarnia Down", status: "partner" });
    const t = fakeTelegram();
    const down = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
    const offline = (async () => { throw new Error("network down"); }) as typeof fetch;
    const odd = (async () => Response.json({ rates: [] })) as typeof fetch;
    await handleTelegram(update(fromOwner(`/cost ${e.id} 350 EUR v${v}`)), env, { telegram: t.telegram, fetch: down });
    await handleTelegram(update(fromOwner(`/cost ${e.id} 280 gbp`)), env, { telegram: t.telegram, fetch: offline });
    await handleTelegram(update(fromOwner(`/cost ${e.id} 300 USD v${v}`)), env, { telegram: t.telegram, fetch: odd });
    expect(t.sent).toEqual([
      "Couldn't get the NBP EUR rate; nothing was recorded. Try again, or send the cost in PLN.",
      "Couldn't get the NBP GBP rate; nothing was recorded. Try again, or send the cost in PLN.",
      "Couldn't get the NBP USD rate; nothing was recorded. Try again, or send the cost in PLN.",
    ]);
    expect(await getEscalation(env.DB, e.id)).toMatchObject({ status: "open", decision_note: null, delivered_at: null });
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      expect(agent.sql<{ n: number }>`SELECT COUNT(*) AS n FROM printer_costs`[0].n).toBe(0);
    });
    expect(await vendorJobFor(env.DB, order.id)).toBeNull();
  });

  it("refuses a printer that isn't screened or a partner, and records nothing", async () => {
    const { order, e } = await orderWithCostRequest();
    const candidate = await addVendor({ name: "Unchecked Print", status: "candidate" });
    const paused = await addVendor({ name: "Resting Print", status: "paused" });
    const t = fakeTelegram();
    const deps = { telegram: t.telegram, fetch: noFetch };
    await handleTelegram(update(fromOwner(`/cost ${e.id} 350 EUR v${candidate}`)), env, deps);
    await handleTelegram(update(fromOwner(`/cost ${e.id} 1000 v${paused}`)), env, deps);
    await handleTelegram(update(fromOwner(`/cost ${e.id} 1000 v999999`)), env, deps);
    expect(t.sent).toEqual([
      `Printer #${candidate} isn't screened; nothing was recorded.`,
      `Printer #${paused} is paused; nothing was recorded.`,
      "Printer #999999 doesn't exist; nothing was recorded.",
    ]);
    expect((await getEscalation(env.DB, e.id))?.status).toBe("open");
    expect(await vendorJobFor(env.DB, order.id)).toBeNull();
  });

  it("refuses a currency written as a symbol, name or other code, and records nothing", async () => {
    const { order, stub, e } = await orderWithCostRequest();
    const t = fakeTelegram();
    const deps = { telegram: t.telegram, fetch: noFetch };
    for (const w of ["chf", "€", "zł", "euro rush"]) await handleTelegram(update(fromOwner(`/cost ${e.id} 350 ${w}`)), env, deps);
    const hint = "can't be converted here: give the cost in PLN, EUR, GBP, USD or INR. Nothing was recorded. If it's part of the note, put PLN before it.";
    expect(t.sent).toEqual([`CHF ${hint}`, `€ ${hint}`, `zł ${hint}`, `euro ${hint}`]);
    expect(await getEscalation(env.DB, e.id)).toMatchObject({ status: "open", decision_note: null });
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      expect(agent.sql<{ n: number }>`SELECT COUNT(*) AS n FROM printer_costs`[0].n).toBe(0);
    });
    expect(await vendorJobFor(env.DB, order.id)).toBeNull();
  });

  /** The order agent's "Printer cost from the owner" line for escalation `id`. */
  async function costLine(stub: Awaited<ReturnType<typeof orderWithCostRequest>>["stub"], id: number): Promise<string> {
    let line = "";
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      line = agent.sql<{ text: string }>`SELECT text FROM inbox`.map((r) => r.text).find((x) => x.startsWith(`Printer cost from the owner (escalation #${id})`)) ?? "";
    });
    return line;
  }

  it("refuses another printer once the order's job is booked; the cost alone still records", async () => {
    const { order, stub, e } = await orderWithCostRequest();
    const first = await addVendor({ name: "First Print", status: "partner" });
    const second = await addVendor({ name: "Second Print", status: "screened" });
    await proposeVendorJob(env.DB, { orderId: order.id, vendorId: first, deliverBy: order.deliver_by, currency: "PLN", cents: 90_000 });
    await markJob(env.DB, order.id, "booked");
    const t = fakeTelegram();
    const deps = { telegram: t.telegram, fetch: noFetch };
    await handleTelegram(update(fromOwner(`/cost ${e.id} 1000 v${second}`)), env, deps);
    expect(t.sent[0]).toBe(`Order ${order.id} is already booked with printer #${first}; nothing was recorded. Send /cost without v<#> to record the cost only.`);
    expect(await getEscalation(env.DB, e.id)).toMatchObject({ status: "open", decision_note: null });
    expect(await costLine(stub, e.id)).toBe("");
    await handleTelegram(update(fromOwner(`/cost ${e.id} 1000`)), env, deps);
    expect(t.sent[1]).toBe(`#${e.id}: 1000.00 PLN recorded for order ${order.id}.`);
    const line = await costLine(stub, e.id);
    expect(line).toContain("1000.00 PLN gross");
    expect(line).not.toContain("printer #");
    expect(await vendorJobFor(env.DB, order.id)).toMatchObject({ vendor_id: first, status: "booked", cost_currency: "PLN", cost_cents: 90_000 });
  });

  it("records the cost but leaves a booked job alone when it's the same printer", async () => {
    const { order, stub, e } = await orderWithCostRequest();
    const first = await addVendor({ name: "Booked Print", status: "partner" });
    await proposeVendorJob(env.DB, { orderId: order.id, vendorId: first, deliverBy: order.deliver_by, currency: "PLN", cents: 90_000 });
    await markJob(env.DB, order.id, "booked");
    const t = fakeTelegram();
    await handleTelegram(update(fromOwner(`/cost ${e.id} 350 EUR v${first}`)), env, { telegram: t.telegram, fetch: nbp(4.2553) });
    expect(t.sent).toEqual([`#${e.id}: 1489.36 PLN (350.00 EUR at 4.2553) recorded for order ${order.id}; printer unchanged (job already booked).`]);
    expect((await getEscalation(env.DB, e.id))?.decision_note).toBe("1489.36 PLN; 350.00 EUR at 4.2553 PLN (NBP 2026-10-01)");
    const line = await costLine(stub, e.id);
    expect(line).toContain('1489.36 PLN gross, delivery included. Owner\'s note: "350.00 EUR at 4.2553 PLN (NBP 2026-10-01)".');
    expect(line).not.toContain("printer #");
    expect(await vendorJobFor(env.DB, order.id)).toMatchObject({ vendor_id: first, status: "booked", cost_currency: "PLN", cost_cents: 90_000 });
  });

  it("moves a still-proposed job to the printer the owner names", async () => {
    const { order, stub, e } = await orderWithCostRequest();
    const first = await addVendor({ name: "Proposed Print", status: "partner" });
    const second = await addVendor({ name: "Chosen Print", status: "screened" });
    await proposeVendorJob(env.DB, { orderId: order.id, vendorId: first, deliverBy: order.deliver_by, currency: "PLN", cents: 90_000 });
    const t = fakeTelegram();
    await handleTelegram(update(fromOwner(`/cost ${e.id} 1200 v${second}`)), env, { telegram: t.telegram, fetch: noFetch });
    expect(t.sent).toEqual([`#${e.id}: 1200.00 PLN recorded for order ${order.id}; printer #${second} Chosen Print.`]);
    expect(await costLine(stub, e.id)).toContain(`Owner's note: "printer #${second} Chosen Print".`);
    expect(await vendorJobFor(env.DB, order.id)).toMatchObject({ vendor_id: second, status: "proposed", cost_currency: "PLN", cost_cents: 120_000 });
  });

  it("/cost without a printer keeps the proposed printer and gives its job the new cost", async () => {
    const { order, stub, e } = await orderWithCostRequest();
    const v = await addVendor({ name: "Kept Print", status: "partner" });
    const t = fakeTelegram();
    await handleTelegram(update(fromOwner(`/cost ${e.id} 1000 v${v}`)), env, { telegram: t.telegram, fetch: noFetch });
    expect(await vendorJobFor(env.DB, order.id)).toMatchObject({ vendor_id: v, status: "proposed", cost_currency: "PLN", cost_cents: 100_000 });
    // The agent asks again for the same order (say, the design changed).
    const again = await createEscalation(env.DB, { orderId: order.id, kind: "cost", summary: "Printer cost again", payload: {} });
    await runInDurableObject(stub, async (agent: OrderAgent) => {
      agent.sql`INSERT INTO escalated (key, escalation_id) VALUES (${`cost:again-${again.id}`}, ${again.id})`;
    });
    await handleTelegram(update(fromOwner(`/cost ${again.id} 350 EUR`)), env, { telegram: t.telegram, fetch: nbp(4.2553) });
    expect(t.sent[1]).toBe(`#${again.id}: 1489.36 PLN (350.00 EUR at 4.2553) recorded for order ${order.id}; printer #${v} kept; add v<#> to change it.`);
    expect(await vendorJobFor(env.DB, order.id)).toMatchObject({ vendor_id: v, status: "proposed", cost_currency: "EUR", cost_cents: 35_000 });
    // The agent's note doesn't name the printer when the owner didn't.
    expect(await costLine(stub, again.id)).not.toContain("printer #");
  });

  it("records the printer's job even when the agent can't be told", async () => {
    const { order, e } = await orderWithCostRequest();
    const v = await addVendor({ name: "Drukarnia Late", status: "screened" });
    const t = fakeTelegram();
    const unreachable = { idFromName() { throw new Error("agent unreachable"); } } as unknown as Env["OrderAgent"];
    const down = ({ ...env, OrderAgent: unreachable }) as Env;
    await handleTelegram(update(fromOwner(`/cost ${e.id} 350 EUR v${v}`)), down, { telegram: t.telegram, fetch: nbp(4.2553) });
    expect(t.sent).toEqual([
      `#${e.id} approved (1489.36 PLN (350.00 EUR at 4.2553) recorded for order ${order.id}; printer #${v} Drukarnia Late), but the agent could not be told. Send /resend ${e.id} to retry.`,
    ]);
    expect(await vendorJobFor(env.DB, order.id)).toMatchObject({ vendor_id: v, cost_currency: "EUR", cost_cents: 35000 });
    await handleTelegram(update(fromOwner(`/resend ${e.id}`)), env, t);
    expect(t.sent[1]).toBe(`#${e.id} re-sent to the agent (approved).`);
  });

  it("/vendors lists printers partners first, with methods, scores and email", async () => {
    const city = "Vendorville";
    const screened = await addVendor({ name: "Alpha Screened", status: "screened", city, methods: ["screen", "dtf"], email: "alpha@example.com" });
    const partner = await addVendor({ name: "Zulu Partner", status: "partner", city, methods: ["embroidery"] });
    const candidate = await addVendor({ name: "Mid Candidate", status: "candidate", city });
    const { order } = await createOrder(env.DB, intake, new Date("2099-01-01T10:00:00Z"));
    await proposeVendorJob(env.DB, { orderId: order.id, vendorId: partner, deliverBy: order.deliver_by, currency: "PLN", cents: 50_000 });
    await markJob(env.DB, order.id, "booked");
    await markJob(env.DB, order.id, "delivered", new Date("2099-10-01T10:00:00Z"));
    const warsaw = await addVendor({ name: "Warszawa Print", status: "screened" });
    const t = fakeTelegram();
    await handleTelegram(update(fromOwner(`/vendors ${city}`)), env, t);
    expect(t.sent[0]).toBe([
      `#${partner} partner · Zulu Partner · Vendorville · embroidery · 1 jobs, 1 on time · no email`,
      `#${screened} screened · Alpha Screened · Vendorville · screen, dtf · 0 jobs, 0 on time · alpha@example.com`,
      `#${candidate} candidate · Mid Candidate · Vendorville · screen · 0 jobs, 0 on time · no email`,
    ].join("\n"));
    await handleTelegram(update(fromOwner("/vendors warszawa")), env, t);
    expect(t.sent[1]).toContain(`#${warsaw} screened · Warszawa Print · Warsaw · screen`);
    expect(t.sent[1]).not.toContain("Vendorville");
    await handleTelegram(update(fromOwner("/vendors")), env, t);
    const all = t.sent[2].split("\n");
    expect(all[0]).toMatch(/^#\d+ partner · /);
    expect(all.length).toBeLessThanOrEqual(21);
    expect(t.sent[2]).toContain(`#${partner} partner · Zulu Partner`);
    await handleTelegram(update(fromOwner("/vendors Atlantis")), env, t);
    expect(t.sent[3]).toBe("No printers in Atlantis.");
  });

  it("/vendors shows the first 20 and says there are more", async () => {
    const city = "Crowdville";
    for (let i = 0; i < 21; i++) await addVendor({ name: `Print ${String(i).padStart(2, "0")}`, status: i === 20 ? "partner" : "screened", city });
    const t = fakeTelegram();
    await handleTelegram(update(fromOwner(`/vendors ${city}`)), env, t);
    const lines = t.sent[0].split("\n");
    expect(lines).toHaveLength(21);
    expect(lines[0]).toContain("partner · Print 20");
    expect(lines[20]).toBe("(first 20 shown)");
  });

  it("/vendor sets a status, and registers a payout address only for a partner", async () => {
    const v = await addVendor({ name: "Payable Print", status: "screened" });
    const given = "0x" + "Ab".repeat(20);
    const addr = given.toLowerCase();
    const t = fakeTelegram();
    const say = (text: string) => handleTelegram(update(fromOwner(text)), env, t);
    await say(`/vendor ${v} pay ${given} BASE`);
    expect((await getVendor(env.DB, v))?.payout_address).toBeNull();
    await say(`/vendor ${v} partner`);
    await say(`/vendor ${v} pay ${given} BASE`);
    expect(await getVendor(env.DB, v)).toMatchObject({ status: "partner", payout_address: addr, payout_chain: "BASE" });
    await say(`/vendor ${v} pay 0x1234 BASE`);
    await say(`/vendor ${v} pay ${addr} base!`);
    await say(`/vendor ${v} pay ${addr}`);
    await say(`/vendor ${v} pay ${addr} BASE now`);
    await say(`/vendor ${v} candidate`);
    await say(`/vendor ${v} pay ${addr} arc-testnet`);
    expect(await getVendor(env.DB, v)).toMatchObject({ payout_address: addr, payout_chain: "ARC-TESTNET" });
    await say(`/vendor ${v} paused`);
    expect(await getVendor(env.DB, v)).toMatchObject({ status: "paused", payout_address: null, payout_chain: null });
    await say(`/vendor ${v} Screened`);
    await say("/vendor 999999 partner");
    await say(`/vendor 999999 pay ${addr} ARC-TESTNET`);
    const usage = "Usage: /vendor <#> partner|screened|paused, or /vendor <#> pay <0x address> <CHAIN>";
    expect(t.sent).toEqual([
      `Printer #${v} must be a partner first: /vendor ${v} partner`,
      `Printer #${v} is now partner.`,
      `Printer #${v} is paid at ${addr} on BASE.`,
      usage,
      usage,
      usage,
      usage,
      usage,
      `Printer #${v} is paid at ${addr} on ARC-TESTNET.`,
      `Printer #${v} is now paused. Its payout address was cleared: after /vendor ${v} partner, register it again with /vendor ${v} pay.`,
      `Printer #${v} is now screened.`,
      "Printer #999999 doesn't exist.",
      "Printer #999999 doesn't exist.",
    ]);
  });

  it("help lists the vendor commands and the new /cost syntax", () => {
    expect(HELP).toContain("/cost <id> <amount> [PLN|EUR|GBP|USD|INR] [v<printer #>] [note]");
    expect(HELP).toContain("/vendors [city]");
    expect(HELP).toContain("/vendor <#> partner|screened|paused");
    expect(HELP).toContain("/vendor <#> pay <0x address> <CHAIN>");
  });
});
