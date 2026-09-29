import { z } from "zod";
import type { BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { formatUnits, type Token } from "../money";
import type { ObligationRow, PayoutRow, TreasuryPolicy } from "../treasury";
import type { ToolHandler } from "./loop";
import { inputSchema, logged, type DecisionLogger, type Logged } from "./tools";

export interface TreasuryContext extends DecisionLogger {
  policy: TreasuryPolicy;
  getObligation(id: number): Promise<ObligationRow | null>;
  walletUnits(): Promise<number | null>;
  payoutsLast24h(): Promise<number>;
  queuedUnits(): Promise<number>;
  queuePayout(ob: ObligationRow): Promise<PayoutRow | null>;
  markEscalated(id: number): Promise<void>;
  holdObligation(id: number, hours: number, note: string): Promise<void>;
  orderMargin(orderId: number): Promise<{ status: string; token: Token; receivedUnits: number; printerCostUnits: number } | null>;
  /** One reserve obligation per order: `created` is false when the order already had one. */
  createReserve(orderId: number, units: number, token: Token): Promise<{ obligation: ObligationRow; created: boolean }>;
  escalateOnce(key: string, e: { orderId: number | null; kind: "approval" | "agent"; summary: string; payload: unknown }): Promise<{ id: number; created: boolean }>;
}

const reason = z.string().trim().min(3).max(500).describe("One sentence on why, for the public decision log");
const PayInput = z.object({ obligationId: z.number().int().positive(), reason });
const HoldInput = z.object({ obligationId: z.number().int().positive(), hours: z.number().int().min(1).max(72).describe("When to look at it again"), reason });
const SweepInput = z.object({ orderId: z.number().int().positive(), bps: z.number().int().min(0).max(10_000).describe("Share of the order's margin for the reserve, in basis points"), reason });
const EscalateInput = z.object({ summary: z.string().trim().min(3).max(500).describe("What the owner needs to decide or know"), reason });

export const TREASURY_TOOLS: BetaTool[] = [
  { name: "pay_obligation", description: "Queue the payout of an existing obligation from the agent wallet. Checked against the destination and its chain, per-payout and 24-hour limits, and the wallet balance.", input_schema: inputSchema(PayInput) },
  { name: "hold_obligation", description: "Decide not to pay an obligation yet, and be reminded after some hours.", input_schema: inputSchema(HoldInput) },
  { name: "sweep_to_reserve", description: "For a closed order, create a reserve obligation for a share of its margin. Pay it with pay_obligation.", input_schema: inputSchema(SweepInput) },
  { name: "escalate", description: "Ask the owner about something you may not decide. Their decision arrives as an event.", input_schema: inputSchema(EscalateInput) },
];

export function makeTreasuryHandlers(ctx: TreasuryContext): Record<string, ToolHandler> {
  const blocked = (detail: string): Logged => ({ verdict: "block", outcome: "blocked", detail, result: { content: `Not paid: ${detail}.`, isError: true } });
  const overLimit = async (ob: ObligationRow, what: string): Promise<Logged> => {
    // No order id: deliver() would otherwise tell the order's agent (and so the host's thread) about treasury internals.
    const e = await ctx.escalateOnce(`limit:${ob.id}`, {
      orderId: null, kind: "approval",
      summary: `Treasury: ${ob.kind} obligation #${ob.id}${ob.order_id !== null ? ` (order ${ob.order_id})` : ""} for ${formatUnits(ob.amount_units)} ${ob.token} is ${what}. Approve to let the treasury agent pay it anyway (Circle's own limit still applies); reject to handle it yourself.`,
      payload: { obligationId: ob.id },
    });
    // Later turns must not retry it and raise the escalation count; the owner's decision moves it on.
    await ctx.markEscalated(ob.id);
    return { verdict: "escalate", outcome: "escalated", detail: `#${e.id}`, result: { content: `Not paid: ${what}. ${e.created ? "Sent to the owner" : "Waiting for the owner"} (#${e.id}); their decision arrives as an event.` } };
  };

  return {
    pay_obligation: logged(ctx, "pay_obligation", PayInput, async ({ obligationId }) => {
      const ob = await ctx.getObligation(obligationId);
      if (!ob) return blocked(`there is no obligation #${obligationId}`);
      if (!["open", "approved"].includes(ob.status)) {
        // A failed payout may have been broadcast anyway (a timeout after sending); a retry uses a new idempotency key, so only the owner decides.
        if (ob.status === "failed") return blocked(`obligation #${ob.id}'s last payout failed; the owner decides whether to retry`);
        return blocked(`obligation #${ob.id} is ${ob.status}`);
      }
      if (ob.token !== "USDC") return blocked("only USDC payouts are configured; escalate");
      if (ob.kind === "refund" && ob.approved_by !== "owner") return blocked("refunds need the owner's approval");
      // A refund of a bridge mint would go to the zero address and burn the money.
      if (/^0x0{40}$/i.test(ob.destination)) return blocked("the destination is the zero address");
      const expected = ob.kind === "printer_cost" ? ctx.policy.payoutAddress : ob.kind === "reserve" ? ctx.policy.reserveAddress : ob.destination;
      if (!expected || expected.toLowerCase() !== ob.destination.toLowerCase()) return blocked(`the destination ${ob.destination} is not the configured address`);
      // The same address on another chain may belong to someone else.
      const chain = ob.kind === "printer_cost" ? ctx.policy.payoutChain : ob.kind === "reserve" ? "ARC" : ob.chain;
      if (ob.chain !== chain) return blocked(`the obligation's chain ${ob.chain} is not the configured chain`);
      if (ob.approved_by !== "owner") {
        if (ob.amount_units > ctx.policy.perTxUnits) return overLimit(ob, `above the per-payout limit of ${formatUnits(ctx.policy.perTxUnits)} USDC`);
        if ((await ctx.payoutsLast24h()) + ob.amount_units > ctx.policy.dailyUnits) return overLimit(ob, `above the 24-hour budget of ${formatUnits(ctx.policy.dailyUnits)} USDC`);
      }
      const balance = await ctx.walletUnits();
      if (balance === null) return blocked("the wallet balance can't be read right now; try again later");
      const queued = await ctx.queuedUnits();
      if (balance - queued < ob.amount_units) return blocked(`not enough USDC: the wallet holds ${formatUnits(balance)} and ${formatUnits(queued)} is already queued`);
      const payout = await ctx.queuePayout(ob);
      if (!payout) return blocked(`obligation #${ob.id} changed; nothing was queued`);
      return { verdict: "allow", outcome: "done", detail: `payout #${payout.id}`, result: { content: `Queued payout #${payout.id}: ${formatUnits(ob.amount_units)} USDC to ${ob.chain}. The wallet runner sends it; its result arrives as an event.` } };
    }),

    hold_obligation: logged(ctx, "hold_obligation", HoldInput, async ({ obligationId, hours, reason: why }) => {
      const ob = await ctx.getObligation(obligationId);
      if (!ob) return { verdict: "none", outcome: "error", detail: "unknown obligation", result: { content: `There is no obligation #${obligationId}.`, isError: true } };
      await ctx.holdObligation(ob.id, hours, why);
      return { verdict: "none", outcome: "done", result: { content: `Held obligation #${ob.id}; you'll be reminded in ${hours} hours.` } };
    }),

    sweep_to_reserve: logged(ctx, "sweep_to_reserve", SweepInput, async ({ orderId, bps }) => {
      const no = (detail: string): Logged => ({ verdict: "block", outcome: "blocked", detail, result: { content: `No sweep: ${detail}.`, isError: true } });
      if (!ctx.policy.reserveAddress) return no("RESERVE_ADDRESS is not set; escalate");
      const m = await ctx.orderMargin(orderId);
      if (!m) return no(`there is no order ${orderId}`);
      if (m.status !== "closed") return no(`order ${orderId} is ${m.status}, not closed`);
      if (m.token !== "USDC") return no("only USDC reserves are configured");
      // Without a recorded cost the whole payment would look like margin.
      if (m.printerCostUnits === 0) return no(`no printer cost is recorded for order ${orderId}; escalate`);
      if (bps < ctx.policy.reserveMinBps || bps > ctx.policy.reserveMaxBps) return no(`choose between ${ctx.policy.reserveMinBps} and ${ctx.policy.reserveMaxBps} bps`);
      const margin = m.receivedUnits - m.printerCostUnits;
      const units = Math.floor((margin * bps) / 10_000);
      if (units < 10_000) return no(`the order's margin (${formatUnits(Math.max(0, margin))} USDC) leaves nothing worth sweeping`);
      const { obligation: reserve, created } = await ctx.createReserve(orderId, units, "USDC");
      if (!created) return no(`order ${orderId} was already swept (obligation #${reserve.id})`);
      return { verdict: "allow", outcome: "done", detail: `obligation #${reserve.id}`, result: { content: `Reserve obligation #${reserve.id}: ${formatUnits(units)} USDC to the reserve. Call pay_obligation to move it.` } };
    }),

    escalate: logged(ctx, "escalate", EscalateInput, async ({ summary }) => {
      const oneLine = summary.replace(/\s+/g, " ");
      // The payload routes the owner's decision back to the treasury (deliver() in telegram-webhook.ts).
      const e = await ctx.escalateOnce(`agent:${oneLine}`, { orderId: null, kind: "agent", summary: `Treasury: ${oneLine}`, payload: { treasury: true } });
      return { verdict: "escalate", outcome: "escalated", detail: `#${e.id}`, result: { content: e.created ? `Sent to the owner as #${e.id}; their decision arrives as an event.` : `Already with the owner as #${e.id}.` } };
    }),
  };
}
