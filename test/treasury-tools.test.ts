import { describe, expect, it } from "vitest";
import type { ObligationRow, PayoutRow, TreasuryPolicy } from "../src/treasury";
import type { VendorRow } from "../src/vendors";
import { TREASURY_TOOLS, makeTreasuryHandlers, type TreasuryContext } from "../src/agent/treasury-tools";

const PAYOUT = "0x3333333333333333333333333333333333333333";
const RESERVE = "0x4444444444444444444444444444444444444444";
const policy: TreasuryPolicy = { perTxUnits: 500_000_000, dailyUnits: 1_500_000_000, reserveMinBps: 1000, reserveMaxBps: 3000, payoutChain: "MATIC", payoutAddress: PAYOUT, reserveAddress: RESERVE };

function ob(o: Partial<ObligationRow> = {}): ObligationRow {
  return { id: 1, order_id: 7, kind: "printer_cost", token: "USDC", amount_units: 257_500_000, destination: PAYOUT, chain: "MATIC", due_at: "2099-01-01T00:00:00.000Z",
    status: "open", approved_by: null, source_ref: "x", note: null, vendor_id: null, created_at: "2099-01-01T00:00:00.000Z", settled_at: null, ...o };
}

function fake(obligations: ObligationRow[], o: Partial<{ balance: number | null; last24h: number; queued: number; margin: { status: string; token: "USDC"; receivedUnits: number; printerCostUnits: number } | null; vendors: VendorRow[]; latestPayout: number | null }> = {}) {
  const state = { queued: [] as number[], held: [] as [number, number][], reserves: [] as [number, number][], escalations: [] as string[], escalationKeys: [] as string[], escalationPayloads: [] as unknown[], escalated: [] as number[], decisions: [] as Array<Record<string, unknown>> };
  const ctx: TreasuryContext = {
    policy,
    async getObligation(id) { return obligations.find((x) => x.id === id) ?? null; },
    async getVendor(id) { return (o.vendors ?? []).find((v) => v.id === id) ?? null; },
    async vendorObligations(orderId) { return obligations.filter((x) => x.order_id === orderId && x.vendor_id !== null); },
    async latestPayoutId() { return o.latestPayout ?? null; },
    async walletUnits() { return o.balance === undefined ? 10_000_000_000 : o.balance; },
    async payoutsLast24h() { return o.last24h ?? 0; },
    async queuedUnits() { return o.queued ?? 0; },
    async queuePayout(x) { state.queued.push(x.id); return { id: 100 + x.id, obligation_id: x.id } as PayoutRow; },
    async markEscalated(id) { state.escalated.push(id); },
    async holdObligation(id, hours) { state.held.push([id, hours]); },
    async orderMargin() { return o.margin === undefined ? { status: "closed", token: "USDC", receivedUnits: 380_000_000, printerCostUnits: 257_500_000 } : o.margin; },
    async createReserve(orderId, units) {
      // Like the ledger: one reserve per order; a repeat returns the first row.
      state.reserves.push([orderId, units]);
      return { obligation: ob({ id: 50, kind: "reserve", amount_units: state.reserves[0][1], destination: RESERVE, chain: "ARC" }), created: state.reserves.length === 1 };
    },
    async escalateOnce(key, e) { state.escalations.push(e.summary); state.escalationKeys.push(key); state.escalationPayloads.push(e.payload); return { id: 9, created: state.escalations.length === 1 }; },
    async logDecision(d) { state.decisions.push(d as unknown as Record<string, unknown>); },
  };
  return { state, h: makeTreasuryHandlers(ctx) };
}

describe("treasury tools", () => {
  it("defines four tools that all require a reason", () => {
    expect(TREASURY_TOOLS.map((t) => t.name)).toEqual(["pay_obligation", "hold_obligation", "sweep_to_reserve", "escalate"]);
    for (const t of TREASURY_TOOLS) expect(t.input_schema.required).toContain("reason");
  });

  it("queues a printer cost within limits", async () => {
    const { h, state } = fake([ob()]);
    const r = await h.pay_obligation({ obligationId: 1, reason: "deposit paid; printer cost goes to the payout account" });
    expect(r.content).toBe("Queued payout #101: 257.500000 USDC to MATIC. The wallet runner sends it; its result arrives as an event.");
    expect(state.queued).toEqual([1]);
    expect(state.decisions[0]).toMatchObject({ tool: "pay_obligation", verdict: "allow", outcome: "done" });
  });

  it("escalates above the per-payout or 24-hour limit, but pays once the owner approved", async () => {
    const big = fake([ob({ amount_units: 600_000_000 })]);
    const r = await big.h.pay_obligation({ obligationId: 1, reason: "pay it" });
    expect(r.content).toContain("Not paid: above the per-payout limit of 500.000000 USDC");
    expect(big.state.queued).toEqual([]);
    expect(big.state.escalated).toEqual([1]);
    expect(big.state.decisions[0]).toMatchObject({ verdict: "escalate", outcome: "escalated" });
    const daily = fake([ob()], { last24h: 1_400_000_000 });
    expect((await daily.h.pay_obligation({ obligationId: 1, reason: "pay it" })).content).toContain("above the 24-hour budget");
    const approved = fake([ob({ amount_units: 600_000_000, status: "approved", approved_by: "owner" })]);
    expect((await approved.h.pay_obligation({ obligationId: 1, reason: "owner approved" })).content).toMatch(/^Queued payout/);
  });

  it("blocks unapproved refunds, foreign destinations, EURC, closed obligations and a short or unknown balance", async () => {
    const cases: Array<[ObligationRow, Partial<{ balance: number | null; queued: number }>, string]> = [
      [ob({ kind: "refund", destination: "0x9999999999999999999999999999999999999999", chain: "ARC" }), {}, "refunds need the owner's approval"],
      [ob({ kind: "refund", destination: "0x0000000000000000000000000000000000000000", chain: "ARC", status: "approved", approved_by: "owner" }), {}, "the destination is the zero address"],
      [ob({ destination: "0x9999999999999999999999999999999999999999" }), {}, "is not the configured address"],
      [ob({ token: "EURC" }), {}, "only USDC payouts are configured"],
      [ob({ chain: "ARC" }), {}, "the obligation's chain ARC is not the configured chain"],
      [ob({ kind: "reserve", destination: RESERVE, chain: "MATIC" }), {}, "the obligation's chain MATIC is not the configured chain"],
      [ob({ status: "paid" }), {}, "obligation #1 is paid"],
      [ob({ status: "failed" }), {}, "last payout failed"],
      [ob(), { balance: 300_000_000, queued: 100_000_000 }, "not enough USDC: the wallet holds 300.000000 and 100.000000 is already queued"],
      [ob(), { balance: null }, "the wallet balance can't be read"],
    ];
    for (const [o, opts, text] of cases) {
      const { h, state } = fake([o], opts);
      const r = await h.pay_obligation({ obligationId: 1, reason: "try" });
      expect(r.isError, text).toBe(true);
      expect(String(r.content)).toContain(text);
      expect(state.queued).toEqual([]);
    }
  });

  it("pays a reserve on Arc and a refund on its own chain", async () => {
    expect((await fake([ob({ kind: "reserve", destination: RESERVE, chain: "ARC" })]).h.pay_obligation({ obligationId: 1, reason: "reserve share" })).content).toMatch(/^Queued payout/);
    const refund = ob({ kind: "refund", destination: "0x9999999999999999999999999999999999999999", chain: "ARC", approved_by: "owner", status: "approved" });
    expect((await fake([refund]).h.pay_obligation({ obligationId: 1, reason: "owner approved the refund" })).content).toMatch(/^Queued payout/);
  });

  it("holds an obligation for a number of hours", async () => {
    const { h, state } = fake([ob()]);
    const r = await h.hold_obligation({ obligationId: 1, hours: 12, reason: "deposit arrived late; waiting for the owner" });
    expect(r.content).toBe("Held obligation #1; you'll be reminded in 12 hours.");
    expect(state.held).toEqual([[1, 12]]);
  });

  it("sweeps a share of a closed order's margin to the reserve within the allowed range", async () => {
    const { h, state } = fake([]);
    const low = await h.sweep_to_reserve({ orderId: 7, bps: 500, reason: "small sweep" });
    expect(low.content).toContain("choose between 1000 and 3000 bps");
    const r = await h.sweep_to_reserve({ orderId: 7, bps: 2000, reason: "treasury is healthy" });
    // margin 380 - 257.5 = 122.5 USDC; 20% = 24.5 USDC
    expect(r.content).toBe("Reserve obligation #50: 24.500000 USDC to the reserve. Call pay_obligation to move it.");
    expect(state.reserves).toEqual([[7, 24_500_000]]);
    const open = fake([], { margin: { status: "balance_paid", token: "USDC", receivedUnits: 380_000_000, printerCostUnits: 257_500_000 } });
    expect((await open.h.sweep_to_reserve({ orderId: 7, bps: 2000, reason: "too early" })).content).toContain("order 7 is balance_paid, not closed");
  });

  it("blocks a sweep when no printer cost is recorded for the order", async () => {
    const { h, state } = fake([], { margin: { status: "closed", token: "USDC", receivedUnits: 380_000_000, printerCostUnits: 0 } });
    const r = await h.sweep_to_reserve({ orderId: 7, bps: 2000, reason: "order closed" });
    expect(r.isError).toBe(true);
    expect(r.content).toBe("No sweep: no printer cost is recorded for order 7; escalate.");
    expect(state.reserves).toEqual([]);
  });

  it("blocks a second sweep of the same order, whatever the amount", async () => {
    const { h, state } = fake([]);
    expect((await h.sweep_to_reserve({ orderId: 7, bps: 2000, reason: "order closed" })).content).toMatch(/^Reserve obligation #50/);
    for (const bps of [2000, 3000]) {
      const again = await h.sweep_to_reserve({ orderId: 7, bps, reason: "order closed" });
      expect(again.isError).toBe(true);
      expect(again.content).toBe("No sweep: order 7 was already swept (obligation #50).");
    }
    expect(state.decisions.slice(1).map((d) => d.verdict)).toEqual(["block", "block"]);
  });

  it("escalates once", async () => {
    const { h } = fake([]);
    expect((await h.escalate({ summary: "Printer asked for a higher price", reason: "outside my limits" })).content).toBe("Sent to the owner as #9; their decision arrives as an event.");
    expect((await h.escalate({ summary: "Printer asked for a higher price", reason: "again" })).content).toBe("Already with the owner as #9.");
  });

  describe("a partner printer's milestones", () => {
    const VADDR = "0x" + "ab".repeat(20);
    const vendor = (o: Partial<VendorRow> = {}): VendorRow => ({
      id: 3, name: "Drukarnia", city: "Warsaw", country: "PL", methods: "[\"screen\"]", email: null, website: null, tax_id_type: null, tax_id: null,
      tax_status: null, tax_checked_at: null, lead_days: null, lat: null, lng: null, status: "partner", payout_address: VADDR, payout_chain: "BASE",
      source_ref: "v:3", created_at: "2099-01-01T00:00:00.000Z", updated_at: "2099-01-01T00:00:00.000Z", ...o,
    });
    const milestone = (o: Partial<ObligationRow> = {}) => ob({ vendor_id: 3, destination: VADDR, chain: "BASE", amount_units: 128_750_000, ...o });

    it("pays a milestone to the printer's registered address and chain, not the payout account", async () => {
      const { h, state } = fake([milestone()], { vendors: [vendor()] });
      const r = await h.pay_obligation({ obligationId: 1, reason: "deposit paid; first milestone to the printer" });
      expect(r.content).toBe("Queued payout #101: 128.750000 USDC to BASE. The wallet runner sends it; its result arrives as an event.");
      expect(state.queued).toEqual([1]);
      // The address is compared without regard to case (a checksummed destination is the same address).
      const mixed = fake([milestone({ destination: "0x" + "AB".repeat(20) })], { vendors: [vendor()] });
      expect((await mixed.h.pay_obligation({ obligationId: 1, reason: "first milestone" })).content).toMatch(/^Queued payout/);
    });

    it("sends a milestone whose printer isn't a partner, or whose address or chain changed, to the owner", async () => {
      const notPartner = (why: string) => `Treasury: printer_cost obligation #1 (order 7) for 128.750000 USDC can't be paid: printer #3 ${why}. Approve once the printer is registered again (the treasury re-checks); reject if you pay it by hand or it isn't owed (that settles it).`;
      // Approving alone would loop: the milestone keeps its old address, so the owner re-registers it or pays by hand.
      const moved = (chain: string) => `Treasury: printer_cost obligation #1 (order 7) for 128.750000 USDC can't be paid: it is fixed to printer #3's old address ${VADDR} on ${chain}. Re-register that address with /vendor 3 pay ${VADDR} ${chain} and approve, or reject and pay the printer by hand (that settles it).`;
      const cases: Array<[ObligationRow, VendorRow[], string, string]> = [
        // Pausing clears the payout, as the registry does.
        [milestone(), [vendor({ status: "paused", payout_address: null, payout_chain: null })], "printer #3 is not a partner", notPartner("is not a partner")],
        [milestone(), [vendor({ status: "screened", payout_address: null, payout_chain: null })], "printer #3 is not a partner", notPartner("is not a partner")],
        [milestone(), [], "printer #3 is not a partner", notPartner("is not a partner")],
        // The owner's approval of a late deposit doesn't pass a paused printer.
        [milestone({ status: "approved", approved_by: "owner" }), [vendor({ status: "paused", payout_address: null, payout_chain: null })], "printer #3 is not a partner", notPartner("is not a partner")],
        [milestone(), [vendor({ payout_address: "0x" + "cd".repeat(20) })], "the destination is not printer #3's registered address", moved("BASE")],
        [milestone(), [vendor({ payout_address: null, payout_chain: null })], "the destination is not printer #3's registered address", moved("BASE")],
        [milestone(), [vendor({ payout_chain: "ARC" })], "the chain is not printer #3's registered chain", moved("BASE")],
        [milestone({ chain: "MATIC" }), [vendor()], "the chain is not printer #3's registered chain", moved("MATIC")],
      ];
      for (const [o, vendors, what, summary] of cases) {
        const { h, state } = fake([o], { vendors });
        const r = await h.pay_obligation({ obligationId: 1, reason: "try" });
        expect(r.content, what).toBe(`Not paid: ${what}. Sent to the owner (#9); their decision arrives as an event.`);
        expect(state.queued).toEqual([]);
        expect(state.escalated).toEqual([1]);
        expect(state.escalationKeys).toEqual(["printer:1"]);
        expect(state.escalationPayloads).toEqual([{ obligationId: 1 }]);
        expect(state.escalations).toEqual([summary]);
        // #3 only: the printer's name never reaches the treasury's texts.
        expect(state.escalations[0]).not.toContain("Drukarnia");
        expect(state.decisions[0]).toMatchObject({ verdict: "escalate", outcome: "escalated", detail: "#9" });
      }
    });

    it("carries the obligation's latest payout, so the owner can still decide it after a payout", async () => {
      const { h, state } = fake([milestone({ status: "approved", approved_by: "owner" })], { vendors: [vendor({ status: "paused", payout_address: null, payout_chain: null })], latestPayout: 42 });
      await h.pay_obligation({ obligationId: 1, reason: "owner approved the retry" });
      expect(state.escalationPayloads).toEqual([{ obligationId: 1, payoutId: 42 }]);
      expect(state.escalated).toEqual([1]);
    });

    it("blocks a waiting milestone, a non-USDC one and one the wallet can't cover", async () => {
      const cases: Array<[ObligationRow, Partial<{ balance: number }>, string]> = [
        [milestone({ status: "waiting" }), {}, "obligation #1 is waiting"],
        [milestone({ token: "EURC" }), {}, "only USDC payouts are configured"],
        [milestone(), { balance: 100_000_000 }, "not enough USDC"],
      ];
      for (const [o, opts, text] of cases) {
        const { h, state } = fake([o], { vendors: [vendor()], ...opts });
        const r = await h.pay_obligation({ obligationId: 1, reason: "try" });
        expect(r.isError, text).toBe(true);
        expect(String(r.content)).toContain(text);
        expect(state.queued).toEqual([]);
        expect(state.escalations).toEqual([]);
        expect(state.decisions[0]).toMatchObject({ verdict: "block", outcome: "blocked" });
      }
    });

    it("holds a milestone, without asking the owner again, while another milestone of its order waits for the owner", async () => {
      const m1 = milestone({ id: 1, status: "escalated" });
      const m2 = milestone({ id: 2 });
      const { h, state } = fake([m1, m2], { vendors: [vendor()] });
      const r = await h.pay_obligation({ obligationId: 2, reason: "second milestone is due" });
      expect(r).toEqual({ content: "Not paid: milestone #1 waits for the owner's decision.", isError: true });
      expect(state.queued).toEqual([]);
      expect(state.escalations).toEqual([]);
      expect(state.escalated).toEqual([]);
      expect(state.decisions[0]).toMatchObject({ verdict: "block", outcome: "blocked", detail: "milestone #1 waits for the owner's decision" });
      // Once the owner approved milestone 1, both go out.
      const approved = fake([milestone({ id: 1, status: "approved", approved_by: "owner" }), m2], { vendors: [vendor()] });
      expect((await approved.h.pay_obligation({ obligationId: 1, reason: "owner approved" })).content).toMatch(/^Queued payout/);
      expect((await approved.h.pay_obligation({ obligationId: 2, reason: "second milestone is due" })).content).toMatch(/^Queued payout/);
      expect(approved.state.queued).toEqual([1, 2]);
      // Another order's escalated milestone, or this order's escalated refund, holds nothing.
      const other = fake([milestone({ id: 1, status: "escalated", order_id: 8 }), ob({ id: 3, kind: "refund", status: "escalated", destination: "0x9999999999999999999999999999999999999999", chain: "ARC" }), m2], { vendors: [vendor()] });
      expect((await other.h.pay_obligation({ obligationId: 2, reason: "second milestone is due" })).content).toMatch(/^Queued payout/);
    });

    it("keeps the per-payout and 24-hour limits for a milestone", async () => {
      const big = fake([milestone({ amount_units: 600_000_000 })], { vendors: [vendor()] });
      expect((await big.h.pay_obligation({ obligationId: 1, reason: "pay it" })).content).toContain("Not paid: above the per-payout limit of 500.000000 USDC");
      expect(big.state.queued).toEqual([]);
      expect(big.state.escalated).toEqual([1]);
      const daily = fake([milestone()], { vendors: [vendor()], last24h: 1_400_000_000 });
      expect((await daily.h.pay_obligation({ obligationId: 1, reason: "pay it" })).content).toContain("above the 24-hour budget");
      expect(daily.state.queued).toEqual([]);
    });

    it("never pays an owner's printer cost to a printer's address", async () => {
      const { h, state } = fake([ob({ destination: VADDR, chain: "BASE" })], { vendors: [vendor()] });
      const r = await h.pay_obligation({ obligationId: 1, reason: "try" });
      expect(r.content).toContain(`the destination ${VADDR} is not the configured address`);
      expect(state.queued).toEqual([]);
    });
  });
});
