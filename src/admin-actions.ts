import { cashoutAmount, getCashout, getSupplierPayment, latestCashout, logAdminAction, PAY_CURRENCIES, queueCashout, retryWithdrawal, setSupplierPaymentStatus, type PayMethod } from "./back-office";
import { createEscalation } from "./escalations";
import { plnPer } from "./fx";
import { createTelegram, notifyOwner } from "./telegram";
import { decide } from "./telegram-webhook";
import { getVendor, setVendorPayDetails } from "./vendors";

const METHODS: PayMethod[] = ["card", "blik", "transfer"];
const BACK = /^\/admin(?:\/[A-Za-z0-9/_-]*)?$/;

function redirect(back: string | null, msg: string): Response {
  const to = back && BACK.test(back) ? back : "/admin";
  return new Response(null, { status: 303, headers: { location: `${to}?msg=${encodeURIComponent(msg.slice(0, 200))}`, "cache-control": "no-store" } });
}

/** POST /admin/…: the caller already verified the Access JWT; this checks the Origin and runs one action. */
export async function handleAdminPost(request: Request, env: Env, who: { email: string | null }): Promise<Response> {
  const url = new URL(request.url);
  if (request.headers.get("origin") !== url.origin) return new Response("Forbidden", { status: 403 });
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const field = (k: string) => { const v = form.get(k); return typeof v === "string" ? v.trim() : ""; };
  const back = field("back") || null;
  const log = (action: string, target: string, detail?: unknown) => logAdminAction(env.DB, { email: who.email, action, target, detail });
  const path = url.pathname;
  let m: RegExpExecArray | null;

  if ((m = /^\/admin\/escalations\/(\d{1,9})\/decide$/.exec(path))) {
    const decision = field("decision");
    if (decision !== "approve" && decision !== "reject") return redirect(back, "Choose approve or reject.");
    const reply = await decide(env, Number(m[1]), decision === "approve" ? "approved" : "rejected", field("note").slice(0, 500) || null);
    await log(decision, `escalation:${m[1]}`);
    return redirect(back, reply);
  }

  if ((m = /^\/admin\/payments\/(\d{1,9})\/cashout$/.exec(path))) {
    const sp = await getSupplierPayment(env.DB, Number(m[1]));
    if (!sp) return new Response("Not found", { status: 404 });
    if (sp.status === "cashing_out") return redirect(back, "This payment is already cashing out.");
    if (sp.status !== "due") return redirect(back, `This payment is ${sp.status.replace("_", " ")}; there is nothing to cash out.`);
    const prior = await latestCashout(env.DB, sp.id);
    if (prior?.status === "failed" && prior.sold_units !== null) return redirect(back, "Its USDC was already sold: use Retry withdrawal.");
    const sent = await env.DB
      .prepare(
        `SELECT 1 AS n FROM obligations o JOIN payouts p ON p.obligation_id = o.id
         WHERE o.order_id = ? AND o.kind = 'printer_cost' AND o.vendor_id IS NULL AND p.status = 'sent' LIMIT 1`,
      ).bind(sp.order_id).first();
    if (!sent) return redirect(back, "The treasury hasn't sent this printer cost to Kraken yet.");
    const rates = new Map<string, number | null>();
    for (const code of new Set([sp.currency, "EUR"])) rates.set(code, await plnPer(env.DB, code));
    const amount = cashoutAmount({ currency: sp.currency, amountCents: sp.amount_cents }, (c) => (c === "PLN" ? 1 : rates.get(c) ?? null), {
      gbpEnabled: (env.KRAKEN_GBP_ENABLED as string) === "1",
      buffer: Number(env.CASHOUT_FX_BUFFER) >= 0 ? Number(env.CASHOUT_FX_BUFFER) : 0.02,
    });
    if (!amount) return redirect(back, `No fresh NBP rate for ${rates.get(sp.currency) === null ? sp.currency : "EUR"}: try again after the next hourly refresh.`);
    const c = await queueCashout(env.DB, sp.id, amount);
    if (!c) return redirect(back, "This payment is already cashing out.");
    await log("cashout", `supplier_payment:${sp.id}`, { cashout: c.id, ...amount });
    return redirect(back, `Cash-out queued: ${(amount.fiatCents / 100).toFixed(2)} ${amount.fiat} to your ${amount.fiat} account. The wallet runner sells and withdraws it.`);
  }

  if ((m = /^\/admin\/payments\/(\d{1,9})\/paid$/.exec(path))) {
    const sp = await getSupplierPayment(env.DB, Number(m[1]));
    if (!sp) return new Response("Not found", { status: 404 });
    const method = field("method") as PayMethod;
    if (!METHODS.includes(method)) return redirect(back, "Choose card, blik or transfer.");
    const date = field("date");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00.000Z`))) return redirect(back, "Give the date as YYYY-MM-DD.");
    if (sp.status === "cashing_out" && field("confirm") !== "1") return redirect(back, "A cash-out is still in progress: tick 'money has arrived' to mark it paid anyway.");
    const ok = await setSupplierPaymentStatus(env.DB, sp.id, ["due", "cashing_out", "ready"], "paid", {
      method, reference: field("reference").slice(0, 100) || null, paidAt: `${date}T12:00:00.000Z`,
    });
    if (!ok) return redirect(back, `This payment is already ${sp.status}.`);
    await log("paid", `supplier_payment:${sp.id}`, { method });
    return redirect(back, `Printer payment for order ${sp.order_id} marked paid (${method}).`);
  }

  if ((m = /^\/admin\/payments\/(\d{1,9})\/cancel$/.exec(path))) {
    const sp = await getSupplierPayment(env.DB, Number(m[1]));
    if (!sp) return new Response("Not found", { status: 404 });
    const ok = await setSupplierPaymentStatus(env.DB, sp.id, ["due", "ready"], "cancelled", { note: field("note").slice(0, 300) || null });
    if (!ok) return redirect(back, sp.status === "cashing_out" ? "A cash-out is in progress: wait for it, then cancel." : `This payment is already ${sp.status}.`);
    await log("cancel", `supplier_payment:${sp.id}`);
    return redirect(back, `Printer payment for order ${sp.order_id} cancelled.`);
  }

  if ((m = /^\/admin\/cashouts\/(\d{1,9})\/retry$/.exec(path))) {
    const c = await getCashout(env.DB, Number(m[1]));
    if (!c) return new Response("Not found", { status: 404 });
    if (!(await retryWithdrawal(env.DB, c.id))) return redirect(back, `Cash-out #${c.id} can't be retried (it is ${c.status}).`);
    await log("retry_withdrawal", `cashout:${c.id}`);
    return redirect(back, `Cash-out #${c.id} will retry the withdrawal on the runner's next poll.`);
  }

  if ((m = /^\/admin\/suppliers\/(\d{1,9})$/.exec(path))) {
    const before = await getVendor(env.DB, Number(m[1]));
    if (!before) return new Response("Not found", { status: 404 });
    const payCurrency = field("pay_currency");
    if (!(PAY_CURRENCIES as readonly string[]).includes(payCurrency)) return redirect(back, `Currency must be one of ${PAY_CURRENCIES.join(", ")}.`);
    const howToPay = field("how_to_pay").replace(/\s+/g, " ").slice(0, 300) || null;
    await setVendorPayDetails(env.DB, before.id, { payCurrency, howToPay });
    await log("supplier", `vendor:${before.id}`, { payCurrency, howToPay });
    // No order: deliver() never forwards this to an agent, and the note may hold a phone number.
    const e = await createEscalation(env.DB, {
      orderId: null, kind: "system", payload: { vendorId: before.id },
      summary: `Printer #${before.id} payment details changed by ${who.email ?? "the dashboard"}: currency ${before.pay_currency ?? "—"} → ${payCurrency}; how to pay "${before.how_to_pay ?? ""}" → "${howToPay ?? ""}".`,
    });
    await notifyOwner(env.DB, createTelegram(env.TELEGRAM_BOT_TOKEN), env.TELEGRAM_OWNER_CHAT_ID, e);
    return redirect(back, `Printer #${before.id} updated.`);
  }

  return new Response("Not found", { status: 404 });
}
