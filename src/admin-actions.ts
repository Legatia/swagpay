import { logAdminAction, PAY_CURRENCIES } from "./back-office";
import { getOrderById } from "./db";
import { createEscalation } from "./escalations";
import { cancelSupplierPayment, cashOut, decideAsOwner, markSupplierPaid, retryCashoutWithdrawal, type ActionResult } from "./owner-actions";
import { createTelegram, notifyOwner } from "./telegram";
import { addOffer, deleteOffer, useOffer } from "./offers";
import { getVendor, setVendorPayDetails } from "./vendors";

const AMOUNT = /^\d{1,7}(?:[.,]\d{1,2})?$/;
/** "12,5" → 1250; null when it isn't a plain amount with at most two decimals. */
function toCents(text: string): number | null {
  if (!AMOUNT.test(text)) return null;
  const [whole, frac = ""] = text.replace(",", ".").split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}
const BACK = /^\/admin(?:\/[A-Za-z0-9/_-]*)?$/;

function redirect(back: string | null, msg: string): Response {
  const to = back && BACK.test(back) ? back : "/admin";
  return new Response(null, { status: 303, headers: { location: `${to}?msg=${encodeURIComponent(msg.slice(0, 200))}`, "cache-control": "no-store", "referrer-policy": "same-origin" } });
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

  const answer = (r: ActionResult) => (r.message === "Not found." && !r.ok ? new Response("Not found", { status: 404 }) : redirect(back, r.message));

  if ((m = /^\/admin\/escalations\/(\d{1,9})\/decide$/.exec(path))) {
    const decision = field("decision");
    if (decision !== "approve" && decision !== "reject") return redirect(back, "Choose approve or reject.");
    return redirect(back, (await decideAsOwner(env, Number(m[1]), decision, field("note") || null, who.email)).message);
  }

  if ((m = /^\/admin\/payments\/(\d{1,9})\/cashout$/.exec(path))) return answer(await cashOut(env, Number(m[1]), who.email));

  if ((m = /^\/admin\/payments\/(\d{1,9})\/paid$/.exec(path))) {
    return answer(await markSupplierPaid(env, Number(m[1]), { method: field("method"), reference: field("reference") || null, date: field("date"), confirm: field("confirm") === "1" }, who.email));
  }

  if ((m = /^\/admin\/payments\/(\d{1,9})\/cancel$/.exec(path))) return answer(await cancelSupplierPayment(env, Number(m[1]), field("note") || null, who.email));

  if ((m = /^\/admin\/cashouts\/(\d{1,9})\/retry$/.exec(path))) return answer(await retryCashoutWithdrawal(env, Number(m[1]), who.email));

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

  if ((m = /^\/admin\/orders\/(\d{1,9})\/offers$/.exec(path))) {
    const orderId = Number(m[1]);
    if (!(await getOrderById(env.DB, orderId))) return new Response("Not found", { status: 404 });
    const vendor = /^\d{1,9}$/.test(field("vendor_id")) ? await getVendor(env.DB, Number(field("vendor_id"))) : null;
    if (!vendor || (vendor.status !== "screened" && vendor.status !== "partner")) return redirect(back, "Choose a screened or partner printer.");
    const currency = field("currency");
    if (!(PAY_CURRENCIES as readonly string[]).includes(currency)) return redirect(back, `Currency must be one of ${PAY_CURRENCIES.join(", ")}.`);
    const price = toCents(field("price"));
    const delivery = field("delivery") ? toCents(field("delivery")) : 0;
    const other = field("other") ? toCents(field("other")) : 0;
    if (price === null || price <= 0 || delivery === null || other === null) return redirect(back, "Give the price (above 0), delivery and other as amounts like 120 or 12.50.");
    const arrives = field("arrives_at");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(arrives) || Number.isNaN(Date.parse(`${arrives}T12:00:00.000Z`))) return redirect(back, "Give the arrival date as YYYY-MM-DD.");
    const offer = await addOffer(env.DB, { orderId, vendorId: vendor.id, currency, priceCents: price, deliveryCents: delivery, otherCents: other, arrivesAt: arrives, note: field("note").replace(/\s+/g, " ").slice(0, 200) || null });
    await log("offer_add", `order:${orderId}`, { offer: offer.id, vendor: vendor.id, currency, price, delivery, other, arrives });
    return redirect(back, `Offer #${offer.id} added.`);
  }

  if ((m = /^\/admin\/offers\/(\d{1,9})\/use$/.exec(path))) {
    const id = Number(m[1]);
    const reply = await useOffer(env, id);
    // Audit only when this request used the offer (the reply is also a refusal or "already used").
    const row = await env.DB.prepare("SELECT order_id, chosen_at FROM printer_offers WHERE id = ?").bind(id).first<{ order_id: number; chosen_at: string | null }>();
    if (!row) return new Response("Not found", { status: 404 });
    if (row.chosen_at && reply !== "This offer was already used.") await log("offer_use", `offer:${id}`, { order: row.order_id, reply });
    return redirect(back, reply);
  }

  if ((m = /^\/admin\/offers\/(\d{1,9})\/delete$/.exec(path))) {
    const id = Number(m[1]);
    if (!(await deleteOffer(env.DB, id))) return redirect(back, "That offer is already used or gone; it can't be deleted.");
    await log("offer_delete", `offer:${id}`);
    return redirect(back, `Offer #${id} deleted.`);
  }

  return new Response("Not found", { status: 404 });
}
