import { describe, expect, it } from "vitest";
import { actionOutcome, actionsFor, costCeiling, costCeilingMessage, isSandboxHost, judgeText, money, paymentHint, payToken, payFaucetText, PAY_GAS_NOTE, NETWORK_LINE, PAY_EXACT_TEXT, seenLines } from "../../public/sandbox/text.js";

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
    expect(judgeText(s)).toBe("250.00 EUR withdrawn to your EUR account for order 4 (cash-out #2, ref KR-9). Pay the printer, then press Mark paid.");
  });
  it("rewrites the Kraken app and the failed cash-out wording", () => {
    const s = "Cash-out #3 for order 4 failed: timeout. Its USDC was sold: use Retry withdrawal, or withdraw in the Kraken app and press Paid: https://app.swagpay.me/admin/orders/4";
    const out = judgeText(s);
    expect(out).toBe("Cash-out #3 for order 4 failed: timeout. Its USDC was sold: use Retry withdrawal, or withdraw in the mock bank and press Mark paid.");
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

// Real notices from the backend (src/watcher.ts, src/owner-actions.ts, src/telegram-webhook.ts) with the owner-only instructions.
describe("judgeText: production instructions", () => {
  it("rewrites the deposit notice that says to book the printer", () => {
    expect(judgeText("Order 4: deposit paid (4.12 USDC, tx 0xabc). Book the printer: cost 15.80 PLN gross (quote #7). Printer cost obligation #3: 4.10 USDC to the payout account."))
      .toBe("Order 4: deposit paid (4.12 USDC, tx 0xabc). Printer cost: 15.80 PLN gross (quote #7). Printer cost obligation #3: 4.10 USDC to the payout account.");
  });
  it("rewrites the late deposit notice", () => {
    expect(judgeText("Order 4: deposit paid LATE (due 10:00 Warsaw time) (4.12 USDC, tx 0xabc). Check printing is still possible, then book the printer: cost 15.80 PLN gross (quote #7)."))
      .toBe("Order 4: deposit paid LATE (due 10:00 Warsaw time) (4.12 USDC, tx 0xabc). Check printing is still possible, then pay the printer (simulated) and press Mark paid; cost 15.80 PLN gross (quote #7).");
    expect(judgeText("Approve if printing is still possible: the treasury agent then moves the printer's money and you book the printer (cost 15.80 PLN gross (quote #7))."))
      .toBe("Approve if printing is still possible: the treasury agent then moves the printer's money and you pay the printer (simulated) and press Mark paid (cost 15.80 PLN gross (quote #7)).");
  });
  it("drops the send-the-job instruction", () => {
    expect(judgeText("Order 4: deposit paid 4.12 USDC. Printer #7 Tee Works (screened) is paid by the treasury: #2 (4.10 USDC) now. Send the job to the printer with the files from the order page."))
      .toBe("Order 4: deposit paid 4.12 USDC. Printer #7 Tee Works (screened) is paid by the treasury: #2 (4.10 USDC) now.");
  });
  it("drops the /cost command and the v<#> hint", () => {
    expect(judgeText("Order 4 is already accepted with printer #7; nothing was recorded. Send /cost without v<#> to record the cost only."))
      .toBe("Order 4 is already accepted with printer #7; nothing was recorded.");
    expect(judgeText("Cost 15.80 PLN recorded; printer #7 kept; add v<#> to change it.")).toBe("Cost 15.80 PLN recorded; printer #7 kept.");
  });
  it("says the mock bank sells and withdraws, and Mark paid", () => {
    expect(judgeText("Cash-out queued: 3.70 EUR to your EUR account. The wallet runner sells and withdraws it."))
      .toBe("Cash-out queued: 3.70 EUR to your EUR account. The mock bank sells and withdraws it.");
    expect(judgeText("Order 4: deposit paid (4.12 USDC, tx 0xabc). The treasury agent can't move it (settled): pay from the wallet by hand."))
      .toBe("Order 4: deposit paid (4.12 USDC, tx 0xabc). The treasury agent can't move it (settled): pay the printer yourself (simulated) and press Mark paid.");
  });
  it("never leaves production wording behind", () => {
    const out = judgeText("Book the printer: cost 1.98 PLN gross (quote #1). Send the job to the printer with the files from the order page. Then press Paid: https://app.swagpay.me/admin/orders/4");
    expect(out).not.toMatch(/book the printer|send the job|press paid|\/cost|v<#>|wallet runner|by hand/i);
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

describe("paymentHint", () => {
  const hint = (label, actions, cashout = null) => paymentHint({ label, actions }, cashout);
  it("tells the judge to press Cash out when it is offered", () => {
    expect(hint("ready to cash out", ["cashout", "paid"])).toBe("Next: press Cash out. The mock bank sells the treasury's USDC and withdraws it to your account in about a minute.");
  });
  it("explains the wait for the treasury", () => {
    expect(hint("waiting for the treasury (open)", ["paid"])).toBe("The treasury is sending the printer cost to the mock bank; Cash out appears in a minute or two.");
  });
  it("explains a cash-out in progress", () => {
    expect(hint("cashing out (queued)", ["paid"], { status: "queued" })).toBe("The mock bank is selling and withdrawing.");
  });
  it("tells the judge to pay the printer once the money is in", () => {
    expect(hint("ready to pay", ["paid"])).toBe("The money is in your account. Pay the printer (simulated) and press Mark paid: the simulated printer then takes the job.");
  });
  it("points to Retry after a failed withdrawal", () => {
    expect(hint("withdrawal failed", ["retry", "paid"], { status: "failed" })).toBe("Press Retry.");
  });
  it("covers a payment the treasury won't move", () => {
    expect(hint("the treasury won't move it: pay from your own funds", ["paid"])).toBe("Pay the printer yourself (simulated) and press Mark paid.");
  });
  it("says nothing once paid or cancelled", () => {
    expect(hint("paid (card)", [])).toBe("");
    expect(hint("cancelled", [])).toBe("");
  });
});

describe("pay helper token", () => {
  it("reads USDC or EURC from the pay unit and defaults to USDC", () => {
    expect(payToken("EURC")).toBe("EURC");
    expect(payToken(" eurc ")).toBe("EURC");
    expect(payToken("USDC")).toBe("USDC");
    expect(payToken("")).toBe("USDC");
    expect(payToken(undefined)).toBe("USDC");
    expect(payToken("<script>")).toBe("USDC");
  });
  it("names that token in the faucet line", () => {
    expect(payFaucetText("EURC")).toBe("Pay with testnet EURC on Arc Testnet (chain 5042002). Get up to 10 EURC a day at ");
    expect(payFaucetText("USDC")).toBe("Pay with testnet USDC on Arc Testnet (chain 5042002). Get up to 10 USDC a day at ");
  });
  it("explains the USDC gas for EURC payers", () => {
    expect(PAY_GAS_NOTE).toBe("Gas on Arc is paid in USDC, so get a little USDC from the faucet too.");
  });
});

describe("network line", () => {
  it("gives the public testnet RPC, chain id, native currency and explorer", () => {
    expect(NETWORK_LINE).toBe("Add the network: RPC https://rpc.testnet.arc.io, chain id 5042002, native currency USDC (18 decimals), explorer https://explorer.testnet.arc.io.");
    expect(NETWORK_LINE).not.toContain("arc.network");
  });
});

describe("wrong-amount copy", () => {
  it("points a wrong-amount payer to the transaction hash form on the page", () => {
    expect(PAY_EXACT_TEXT).toBe("Send exactly the amount shown, using the copy button. If you sent a different amount, paste your transaction hash under 'Paid, but it isn't showing' below and it will be matched.");
    expect(PAY_EXACT_TEXT).not.toMatch(/ignored|under 1 USDC/);
  });
});

describe("seenLines", () => {
  const hash = `0x${"ab".repeat(32)}`;
  it("lists each credited transfer with an explorer link", () => {
    const lines = seenLines([{ id: 1, stage: "deposit", token: "USDC", amount: "4.12", txHashes: [hash] }, { id: 2, stage: "balance", token: "USDC", amount: "1.90", txHashes: [] }]);
    expect(lines).toEqual([{ label: "Deposit payment seen on Arc testnet: 4.12 USDC", short: "0xabababab…ababab", href: `https://explorer.testnet.arc.io/tx/${hash}` }]);
  });
  it("ignores missing or malformed hashes (production has no txHashes key)", () => {
    expect(seenLines([{ stage: "deposit", token: "USDC", amount: "1", txHashes: ["0x123", "javascript:alert(1)"] }])).toEqual([]);
    expect(seenLines([{ stage: "deposit", token: "USDC", amount: "1" }])).toEqual([]);
    expect(seenLines(undefined)).toEqual([]);
  });
});
