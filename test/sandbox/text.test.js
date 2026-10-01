import { describe, expect, it } from "vitest";
import { actionOutcome, actionsFor, costCeiling, costCeilingMessage, isSandboxHost, judgeText, money } from "../../public/sandbox/text.js";

describe("isSandboxHost", () => {
  it("matches sandbox hosts and local test mode only", () => {
    expect(isSandboxHost({ hostname: "sandbox.swagpay.me", search: "" })).toBe(true);
    expect(isSandboxHost({ hostname: "app.swagpay.me", search: "?sandbox=1" })).toBe(false);
    expect(isSandboxHost({ hostname: "localhost", search: "?sandbox=1" })).toBe(true);
    expect(isSandboxHost({ hostname: "localhost", search: "" })).toBe(false);
  });
});

describe("judgeText", () => {
  it("rewrites production wording", () => {
    const s = "Approve in Telegram or at https://app.swagpay.me/admin/orders/4. Kraken sells the USDC. Above Circle's spending limit. Reply /resend 4 to retry.";
    const out = judgeText(s);
    expect(out).not.toMatch(/telegram|app\.swagpay\.me|kraken|\/resend/i);
    expect(out).toContain("the mock bank");
    expect(out).toContain("the wallet's spending limit");
  });
  it("leaves normal text alone", () => {
    expect(judgeText("Printer cost needed for order 4.")).toBe("Printer cost needed for order 4.");
  });

  // Real strings from the backend (src/treasury-api.ts, src/owner-actions.ts, src/agent/treasury-tools.ts).
  it("rewrites a cash-out notice that ends in the admin link", () => {
    const s = "250.00 EUR withdrawn to your EUR account for order 4 (cash-out #2, ref KR-9). Pay the printer, then press Paid: https://app.swagpay.me/admin/orders/4";
    expect(judgeText(s)).toBe("250.00 EUR withdrawn to your EUR account for order 4 (cash-out #2, ref KR-9). Pay the printer, then press Paid.");
  });
  it("rewrites the Kraken app and the failed cash-out wording", () => {
    const s = "Cash-out #3 for order 4 failed: timeout. Its USDC was sold: use Retry withdrawal, or withdraw in the Kraken app and press Paid: https://app.swagpay.me/admin/orders/4";
    const out = judgeText(s);
    expect(out).toBe("Cash-out #3 for order 4 failed: timeout. Its USDC was sold: use Retry withdrawal, or withdraw in the mock bank and press Paid.");
    expect(judgeText("The treasury hasn't sent this printer cost to Kraken yet.")).toBe("The treasury hasn't sent this printer cost to the mock bank yet.");
  });
  it("rewrites the spending-limit escalation without CLI instructions", () => {
    const s = "Circle's spending limit refused payout #5 (120.00 USDC, printer_cost obligation #7). Check the agent wallet's transaction history before you approve a retry. Raise the limit with `circle wallet limit` (OTP) and approve to retry, or reject and pay by hand.";
    const out = judgeText(s);
    expect(out).toBe("The wallet's spending limit refused payout #5 (120.00 USDC, printer_cost obligation #7). Check the agent wallet's transaction history before you approve a retry. Approve to retry, or reject and pay by hand.");
  });
  it("rewrites Circle's own limit and drops the /resend sentence", () => {
    expect(judgeText("Approve to let the treasury agent pay it anyway (Circle's own limit still applies); reject to handle it yourself."))
      .toBe("Approve to let the treasury agent pay it anyway (the wallet's spending limit still applies); reject to handle it yourself.");
    expect(judgeText("#5 approved, but the agent could not be told. Send /resend 5 to retry.")).toBe("#5 approved, but the agent could not be told.");
  });
  it("never leaves a dangling period, space or doubled word", () => {
    const outs = [
      judgeText("Approve in Telegram or at https://app.swagpay.me/admin/orders/4."),
      judgeText("Decide on Telegram. Or open https://app.swagpay.me/admin/orders/4 here."),
      judgeText("Done. Reply /resend 4 to retry."),
    ];
    for (const o of outs) {
      expect(o).not.toMatch(/\s\.|\s{2,}|\bhere here\b|\bthis panel this panel\b|\bhere or (?:at )?this panel\b/i);
      expect(o).toBe(o.trim());
    }
    expect(outs[0]).toBe("Approve here.");
  });
});

describe("actionsFor", () => {
  it("notices are acknowledge-only", () => {
    expect(actionsFor({ kind: "payment" })).toEqual([{ label: "Acknowledge", decision: "approve" }]);
    expect(actionsFor({ kind: "system" })).toEqual([{ label: "Acknowledge", decision: "approve" }]);
    expect(actionsFor({ kind: "payout" })).toEqual([{ label: "Approve", decision: "approve" }, { label: "Reject", decision: "reject" }]);
  });
});

describe("actionOutcome", () => {
  it("trusts ok, not the status", () => {
    expect(actionOutcome(200, { ok: false, message: "Already done." })).toEqual({ ok: false, message: "Already done." });
    expect(actionOutcome(200, { ok: true, message: "Done." })).toEqual({ ok: true, message: "Done." });
    expect(actionOutcome(429, null).message).toMatch(/too many actions/i);
    expect(actionOutcome(400, { message: "No open cost request." })).toEqual({ ok: false, message: "No open cost request." });
    expect(actionOutcome(404, null)).toEqual({ ok: false, message: "This action isn't available for this order." });
  });
});

describe("money", () => {
  it("formats cents", () => {
    expect(money(123456, "EUR")).toBe("1,234.56 EUR");
  });
});

describe("costCeiling", () => {
  it("matches the printer cap of about 4 USD in each currency", () => {
    expect(costCeiling("PLN")).toBe(15.8);
    expect(costCeiling("EUR")).toBe(3.7);
    expect(costCeiling("GBP")).toBe(3.13);
    expect(costCeiling("USD")).toBe(4);
    expect(costCeiling("INR")).toBe(343.48);
  });
  it("is null for an unknown currency", () => {
    expect(costCeiling("JPY")).toBeNull();
  });
  it("words the refusal with the ceiling and the faucet reason", () => {
    expect(costCeilingMessage("PLN")).toBe("In the sandbox the printer cost is at most 15.80 PLN (about $4), so the order fits the 10 USDC faucet.");
    expect(costCeilingMessage("USD")).toContain("at most 4.00 USD");
  });
});
