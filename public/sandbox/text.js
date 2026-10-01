// Pure helpers for the sandbox UI (no DOM), so they can be unit-tested.
export function isSandboxHost(loc) {
  if (/^sandbox\./.test(loc.hostname)) return true;
  return (loc.hostname === "localhost" || loc.hostname === "127.0.0.1") && new URLSearchParams(loc.search).get("sandbox") === "1";
}

// A link into the owner dashboard. The path stops before a trailing "." so the sentence keeps its full stop.
const ADMIN_LINK = "https?:\\/\\/app\\.swagpay\\.me\\/admin[\\w\\-/?=&#%]*";

// The backend's notices are written for the real owner (Telegram, /admin, Kraken, Circle limits).
// Judges act in the panel, so the wording is rewritten for them.
export function judgeText(s) {
  const text = String(s ?? "");
  const out = text
    // "Send /resend 5 to retry." is a Telegram command: drop the whole sentence.
    .replace(/[^.]*\/resend\b[^.]*\.?\s*/gi, "")
    // A trailing "press Paid: <link>" becomes "press Paid."; "or at <link>" and "at <link>" are dropped.
    .replace(new RegExp(`(?:\\s+(?:or\\s+)?(?:at|on|via|in))?\\s*:?\\s*${ADMIN_LINK}\\s*$`, "i"), ".")
    .replace(new RegExp(`\\s+or\\s+(?:at|on|via)\\s+${ADMIN_LINK}`, "gi"), "")
    .replace(new RegExp(`(?:\\s+(?:at|on|via))?\\s*:?\\s*${ADMIN_LINK}`, "gi"), "")
    // Owner-only instructions: the judge books and pays the printer in the panel, not by email, Telegram or the wallet.
    .replace(/\s*Send the job to the printer with the files from the order page\.?/gi, "")
    .replace(/\s*Send \/cost without v<#>[^.]*\.?/gi, "")
    .replace(/;\s*add v<#> to change it/gi, "")
    .replace(/\bBook the printer: cost\b/g, "Printer cost:")
    .replace(/\bBook the printer:/g, "Printer cost:")
    .replace(/\bthen book the printer:/gi, "then pay the printer (simulated) and press Mark paid;")
    .replace(/\byou book the printer\b/gi, "you pay the printer (simulated) and press Mark paid")
    .replace(/\bpress Paid\b/g, "press Mark paid")
    .replace(/\bThe wallet runner sells and withdraws it/g, "The mock bank sells and withdraws it")
    .replace(/\bpay from the wallet by hand/gi, "pay the printer yourself (simulated) and press Mark paid")
    // The owner raises the wallet limit with the Circle CLI; judges just approve.
    .replace(/Raise the limit with `circle wallet limit` \(OTP\) and approve/gi, "Approve")
    .replace(/\b(in|on|via) Telegram\b/gi, "here")
    .replace(/\bTelegram\b/gi, "this panel")
    .replace(/\b(?:the\s+)?Kraken(?:\s+app)?\b/g, "the mock bank")
    .replace(/Circle(?:'s)?\s+(?:own\s+|spending\s+)?limit/gi, "the wallet's spending limit")
    .replace(/\bhere or (?:at )?this panel\b/gi, "here")
    .replace(/\bthis panel(?:\s*[.,])?\s*this panel\b/gi, "this panel")
    .replace(/\bhere\s+here\b/gi, "here")
    .replace(/([.!?])\.(?!\.)/g, "$1")
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  // A rewrite at the very start ("Circle's limit ..." -> "the wallet's ...") keeps the sentence capitalised.
  return /^[A-Z]/.test(text) ? out.charAt(0).toUpperCase() + out.slice(1) : out;
}

export function actionsFor(item) {
  if (item.kind === "payment" || item.kind === "system") return [{ label: "Acknowledge", decision: "approve" }];
  return [{ label: "Approve", decision: "approve" }, { label: "Reject", decision: "reject" }];
}

export function actionOutcome(status, body) {
  if (status === 200) return { ok: Boolean(body?.ok), message: judgeText(body?.message ?? (body?.ok ? "Done." : "That didn't work.")) };
  if (status === 429) return { ok: false, message: "Too many actions on this order. Try again in a few minutes." };
  if (status === 404) return { ok: false, message: "This action isn't available for this order." };
  return { ok: false, message: judgeText(body?.message ?? "That didn't work. Check the form and try again.") };
}

export function money(cents, currency) {
  const v = (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v} ${currency}`;
}

// The most a judge may enter as the printer cost, per currency: the simulated printer's cap of about 4 USD (src/sandbox/printer.ts).
// A bigger cost prices the order beyond the 10 USDC testnet faucet.
const COST_CEILING = { PLN: 15.8, EUR: 3.7, GBP: 3.13, USD: 4, INR: 343.48 };

export function costCeiling(currency) {
  return Object.hasOwn(COST_CEILING, currency) ? COST_CEILING[currency] : null;
}

export function costCeilingMessage(currency) {
  const max = costCeiling(currency);
  return `In the sandbox the printer cost is at most ${max === null ? "a few" : max.toFixed(2)} ${currency} (about $4), so the order fits the 10 USDC faucet.`;
}

export const NO_QUOTE_HINT = "No simulated quote for this delivery place (printer suggestions cover Warsaw, Lisbon, London and Mumbai). Enter a small cost, at most 15.80 PLN.";

// One line of next-step guidance for the printer payment, from the payment's label, its offered actions and the cash-out.
export function paymentHint(payment, cashout) {
  const label = String(payment?.label ?? "").toLowerCase();
  const actions = Array.isArray(payment?.actions) ? payment.actions : [];
  if (actions.includes("retry") || label.startsWith("withdrawal failed") || cashout?.status === "failed") return "Press Retry.";
  if (actions.includes("cashout")) return "Next: press Cash out. The mock bank sells the treasury's USDC and withdraws it to your account in about a minute.";
  if (label.startsWith("waiting for the treasury")) return "The treasury is sending the printer cost to the mock bank; Cash out appears in a minute or two.";
  if (label.startsWith("cashing out")) return "The mock bank is selling and withdrawing.";
  if (label.startsWith("ready to pay")) return "The money is in your account. Pay the printer (simulated) and press Mark paid: the simulated printer then takes the job.";
  if (label.startsWith("the treasury won't move it")) return "Pay the printer yourself (simulated) and press Mark paid.";
  return "";
}

// The pay helper follows the token the order page asks for (#pay-unit): EURC for a EUR quote, USDC otherwise.
export function payToken(raw) {
  return String(raw ?? "").trim().toUpperCase() === "EURC" ? "EURC" : "USDC";
}

export function payFaucetText(token) {
  return `Pay with testnet ${token} on Arc Testnet (chain 5042002). Get up to 10 ${token} a day at `;
}

export const PAY_GAS_NOTE = "Gas on Arc is paid in USDC, so get a little USDC from the faucet too.";
