import { getAgentByName } from "agents";
import { PRINTED_STATUSES, getOrderById, setOrderStatus, type OrderRow } from "./db";
import { decideEscalation, getEscalation, listEscalations, listUndelivered, markDelivered, openEscalationFor, statusWord as word, type EscalationRow } from "./escalations";
import { TREASURY_NAME } from "./agent/treasury-agent";
import { fetchNbpRate } from "./fx";
import { TOKEN_FOR, formatCents, formatUnits, isAddress } from "./money";
import { createPaymentRequest } from "./payments";
import { warsawTime } from "./quote-text";
import { acceptedQuote } from "./quotes";
import { createTelegram, type TelegramClient } from "./telegram";
import { decideObligation, setObligationStatus, unpaidVendorObligations, vendorObligations, waitingVendorObligations } from "./treasury";
import {
  cityFromPlace, getVendor, listVendors, markJob, proposeVendorJob, setVendorPayout, setVendorStatus, vendorJobFor, vendorScore,
  type VendorJobRow, type VendorRow, type VendorStatus,
} from "./vendors";

type Update = {
  message?: { chat?: { id?: number }; text?: string };
  callback_query?: { id?: string; data?: string; message?: { chat?: { id?: number } } };
};

const COST_SYNTAX = "/cost <id> <amount> [PLN|EUR|GBP|USD|INR] [v<printer #>] [note]";

export const HELP = [
  "Commands:",
  "/open — open escalations",
  "/approve <id> [note]",
  "/reject <id> [note]",
  "/resend <id> — re-send a decision the agent missed",
  `${COST_SYNTAX} — printer cost (gross, delivery included) for a cost request`,
  "/order <number> — order status",
  "/printed <order> — the printer finished; send the balance request (and release a partner printer's second milestone)",
  "/vendors [city] — printers, partners first",
  "/vendor <#> partner|screened|paused",
  "/vendor <#> pay <0x address> <CHAIN> — where a partner printer is paid (USDC)",
].join("\n");

export function sameSecret(given: string, expected: string): boolean {
  const enc = new TextEncoder();
  const a = enc.encode(given);
  const b = enc.encode(expected);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

/** Tells the order's agent about a decided escalation and records that it was told. Never throws. */
async function deliver(env: Env, row: EscalationRow): Promise<boolean> {
  try {
    // First: a failure here delivers nothing, so /resend repeats it (both steps are idempotent).
    // Only real approvals decide an obligation: a payment notice's Acknowledge button must not approve a payout.
    const payload = (() => { try { return JSON.parse(row.payload_json) as { obligationId?: unknown; payoutId?: unknown; requestId?: unknown; treasury?: unknown; manual?: unknown } | null; } catch { return null; } })();
    const decision = row.status as "approved" | "rejected";
    if (row.kind === "approval" && typeof payload?.obligationId === "number") {
      const obligationId = payload.obligationId;
      // A failed payout may have been broadcast; only the escalation of its latest payout (it carries payoutId) may reopen it.
      const ob = await decideObligation(env.DB, obligationId, decision, typeof payload.payoutId === "number" ? payload.payoutId : null);
      let also = "";
      // A late deposit's approval carries its deposit request and never a payout. Rejecting it means the owner handles the
      // printer, so the treasury pays neither milestone: one still waiting, or one /printed already opened but never queued.
      // Other rejections (a limit, a failed payout, a printer that moved) settle only their own obligation.
      if (decision === "rejected" && ob?.status === "settled" && ob.vendor_id !== null && ob.order_id !== null
        && typeof payload.requestId === "number" && payload.payoutId === undefined) {
        const settled: number[] = [];
        for (const w of await unpaidVendorObligations(env.DB, ob.order_id)) {
          // From its own status only: a milestone queued meanwhile is no longer open, and stays as it is.
          if (await setObligationStatus(env.DB, w.id, [w.status], "settled", { approvedBy: "owner" })) settled.push(w.id);
        }
        if (settled.length) also = `; milestone ${settled.map((id) => `#${id}`).join(", ")} settled too`;
      }
      const now = ob === null ? "" : ob.status === "settled" ? ` (now settled by the owner${also})` : ` (now ${ob.status})`;
      const treasury = await getAgentByName(env.TreasuryAgent, TREASURY_NAME);
      await treasury.ownerDecision({ id: row.id, summary: `obligation #${obligationId}${now}: ${row.summary}` }, decision, row.decision_note);
    } else if (payload?.treasury === true) {
      const treasury = await getAgentByName(env.TreasuryAgent, TREASURY_NAME);
      await treasury.ownerDecision({ id: row.id, summary: row.summary }, decision, row.decision_note);
    } else if (row.kind === "payment" && typeof payload?.obligationId === "number" && payload.manual === true && decision === "approved") {
      // A printer cost the treasury can't move: the owner acknowledged paying it by hand. Nothing for the treasury to do.
      await setObligationStatus(env.DB, payload.obligationId, ["escalated"], "settled", { approvedBy: "owner" });
    }
    if (row.order_id !== null) {
      const order = await getOrderById(env.DB, row.order_id);
      if (order) {
        const agent = await getAgentByName(env.OrderAgent, order.instance);
        const cost = row.kind === "cost" && row.status === "approved" ? /^(\d+\.\d{2}) PLN(?:; ([\s\S]*))?$/.exec(row.decision_note ?? "") : null;
        if (cost) await agent.setPrinterCost(row.id, Number(cost[1]), cost[2] ?? null);
        else await agent.ownerDecision({ id: row.id, kind: row.kind, summary: row.summary }, decision, row.decision_note);
      }
    }
    await markDelivered(env.DB, row.id);
    return true;
  } catch (err) {
    console.error("decision delivery failed", row.id, err);
    return false;
  }
}

/** Decides an escalation in D1, then tells the order's agent. Returns the reply for the owner (short: button toasts stop at 200 characters). */
export async function decide(env: Env, id: number, status: "approved" | "rejected", note: string | null): Promise<string> {
  if (status === "approved") {
    const pending = await getEscalation(env.DB, id);
    if (pending?.kind === "cost" && pending.status === "open") return `#${id} needs a price: ${COST_SYNTAX.replace("<id>", String(id))}`;
  }
  const row = await decideEscalation(env.DB, id, status, note);
  if (!row) {
    const existing = await getEscalation(env.DB, id);
    if (!existing) return `#${id} doesn't exist.`;
    // Orderless escalations (the treasury's, payout results) need delivery too.
    const untold = existing.delivered_at === null ? ` The agent has not been told yet: send /resend ${id}.` : "";
    return `#${id} is already ${word(existing.kind, existing.status)}.${untold}`;
  }
  const w = word(row.kind, row.status);
  return (await deliver(env, row)) ? `#${id} ${w}.` : `#${id} ${w}, but the agent could not be told. Send /resend ${id} to retry.`;
}

/** "1200,50" or "1200.50" → 1200.5; null for anything else or zero. */
export function parsePln(s: string | undefined): number | null {
  if (!s || !/^\d{1,7}([.,]\d{1,2})?$/.test(s)) return null;
  const n = Number(s.replace(",", "."));
  return n > 0 ? n : null;
}

export const COST_CURRENCIES = ["PLN", "EUR", "GBP", "USD", "INR"] as const;
export type CostCurrency = (typeof COST_CURRENCIES)[number];
export type CostArgs = { amount: number; currency: CostCurrency; vendorId: number | null; note: string | null };

const COST_USAGE = `Usage: ${COST_SYNTAX}`;
const ONE_EACH = "Give one currency and one printer at most. Nothing was recorded.";
const ISO_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));
const CURRENCY_WORDS = new Set([
  "€", "$", "£", "₹", "zł", "zl", "euro", "euros", "dollar", "dollars", "pound", "pounds", "rupee", "rupees",
  "złoty", "zloty", "złote", "zlote", "złotych", "zlotych",
]);

/** How to show `w` when it names a currency the amount can't be in ("chf" → "CHF", "€", "euro"), or null. */
function otherCurrency(w: string): string | null {
  const code = w.toUpperCase();
  if (/^[A-Z]{3}$/.test(code) && ISO_CURRENCIES.has(code)) return code;
  return CURRENCY_WORDS.has(w.toLowerCase().replace(/[.,;:!?]+$/, "")) ? w : null;
}

/**
 * The words after `/cost <id>`: the amount, with a currency and a printer (`v<#>`) before or after it in either
 * order, then the note. `id` only fills in the example in the thousands-separator question.
 */
export function parseCostArgs(words: string[], id?: number): CostArgs | { error: string } {
  const got: { currency?: CostCurrency; vendorId?: number } = {};
  let i = 0;
  // After the amount, with no currency named yet, a currency the owner can't use ("350 chf", "350 €") must not
  // become a note on a PLN amount. Naming the currency first ("350 PLN all colours") frees the note.
  const takeTokens = (afterAmount: boolean): string | null => {
    for (; i < words.length; i++) {
      const w = words[i];
      const printer = /^v(\d{1,9})$/i.exec(w);
      if ((COST_CURRENCIES as readonly string[]).includes(w.toUpperCase())) {
        if (got.currency) return ONE_EACH;
        got.currency = w.toUpperCase() as CostCurrency;
      } else if (printer) {
        if (got.vendorId !== undefined) return ONE_EACH;
        got.vendorId = Number(printer[1]);
      } else {
        const other = afterAmount && got.currency === undefined ? otherCurrency(w) : null;
        return other === null
          ? null
          : `${other} can't be converted here: give the cost in PLN, EUR, GBP, USD or INR. Nothing was recorded. If it's part of the note, put PLN before it.`;
      }
    }
    return null;
  };
  const before = takeTokens(false);
  if (before) return { error: before };
  const written = words[i++];
  const amount = parsePln(written);
  if (amount === null) return { error: COST_USAGE };
  // "1 200,50" splits into "1" and "200,50": ask rather than record 1.
  const next = words[i];
  if (next !== undefined && /^\d{3}([.,]\d{1,2})?$/.test(next)) {
    return { error: `Did you mean ${written}${next}? Write the amount without spaces, e.g. /cost ${id ?? "<id>"} 1200.50` };
  }
  const after = takeTokens(true);
  if (after) return { error: after };
  return { amount, currency: got.currency ?? "PLN", vendorId: got.vendorId ?? null, note: words.slice(i).join(" ").trim().slice(0, 500) || null };
}

/**
 * Records the printer cost for a cost request, in PLN grosze. Another currency is converted at today's NBP mid rate;
 * when that rate can't be had, nothing is recorded. A printer (screened or partner) gets the order's proposed job.
 */
export async function giveCost(
  env: Env, id: number, amount: number, note: string | null,
  opts: { currency?: CostCurrency; vendorId?: number | null; fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<string> {
  const currency = opts.currency ?? "PLN";
  const e = await getEscalation(env.DB, id);
  if (!e) return `#${id} doesn't exist.`;
  if (e.kind !== "cost") return `#${id} is not a cost request.`;
  if (e.status !== "open") return `#${id} is already ${e.status}.`;

  let vendor: VendorRow | null = null;
  let order: OrderRow | null = null;
  // A job past `proposed` with this same printer stays as it is; the cost is still recorded.
  let keptJob: VendorJobRow | null = null;
  if (opts.vendorId !== undefined && opts.vendorId !== null) {
    vendor = await getVendor(env.DB, opts.vendorId);
    if (!vendor) return `Printer #${opts.vendorId} doesn't exist; nothing was recorded.`;
    if (vendor.status === "paused") return `Printer #${vendor.id} is paused; nothing was recorded.`;
    if (vendor.status !== "screened" && vendor.status !== "partner") return `Printer #${vendor.id} isn't screened; nothing was recorded.`;
    order = e.order_id === null ? null : await getOrderById(env.DB, e.order_id);
    if (!order) return `#${id} has no order; nothing was recorded.`;
    const job = await vendorJobFor(env.DB, order.id);
    if (job && job.status !== "proposed") {
      if (job.vendor_id !== vendor.id) {
        return `Order ${order.id} is already ${job.status} with printer #${job.vendor_id}; nothing was recorded. Send /cost without v<#> to record the cost only.`;
      }
      keptJob = job;
    }
  }

  // The amount has at most two decimals, so cents are exact; grosze round once.
  const cents = Math.round(amount * 100);
  let grosze = cents;
  let conversion: { shown: string; noted: string } | null = null;
  if (currency !== "PLN") {
    let rate: { plnPerUnit: number; effectiveDate: string };
    try {
      rate = await fetchNbpRate(currency, opts.fetchImpl);
    } catch (err) {
      console.error("NBP rate unavailable", currency, err);
      return `Couldn't get the NBP ${currency} rate; nothing was recorded. Try again, or send the cost in PLN.`;
    }
    grosze = Math.round(cents * rate.plnPerUnit);
    const given = `${formatCents(cents)} ${currency} at ${rate.plnPerUnit}`;
    conversion = { shown: ` (${given})`, noted: `${given} PLN (NBP ${rate.effectiveDate})` };
  }
  if (!(grosze >= 1)) return "That's less than 0.01 PLN; nothing was recorded.";
  const pln = `${formatCents(grosze)} PLN`;

  // deliver() reads the leading "<pln> PLN"; the rest reaches the order agent as the owner's note. It names the
  // printer only when the job is being proposed to it.
  const named = vendor && !keptJob ? `printer #${vendor.id} ${vendor.name}` : null;
  const decisionNote = [pln, conversion?.noted, named, note].filter(Boolean).join("; ");
  const row = await decideEscalation(env.DB, id, "approved", decisionNote, opts.now);
  if (!row) return `#${id} is already ${(await getEscalation(env.DB, id))?.status ?? "decided"}.`;

  // The job is recorded before the agent is told, so a failed delivery (retried with /resend) doesn't lose it.
  let printer = "";
  if (keptJob) printer = `; printer unchanged (job already ${keptJob.status})`;
  else if (!vendor && row.order_id !== null) {
    // No printer named: a proposed job keeps its printer and takes this cost, so the printer is paid the latest cost given.
    try {
      const job = await vendorJobFor(env.DB, row.order_id);
      if (job?.status === "proposed") {
        const kept = await proposeVendorJob(env.DB, { orderId: row.order_id, vendorId: job.vendor_id, deliverBy: job.deliver_by, currency, cents }, opts.now);
        printer = kept ? `; printer #${job.vendor_id} kept; add v<#> to change it` : `; printer #${job.vendor_id}'s job NOT updated (it moved on)`;
      }
    } catch (err) {
      console.error("vendor job cost not updated", id, err);
      printer = `; the printer's job cost was NOT updated (${err instanceof Error ? err.message : String(err)})`;
    }
  } else if (vendor && order) {
    try {
      const job = await proposeVendorJob(env.DB, { orderId: order.id, vendorId: vendor.id, deliverBy: order.deliver_by, currency, cents }, opts.now);
      if (job) printer = `; printer #${vendor.id} ${vendor.name}`;
      else {
        // Only if the job moved on since the check above.
        const current = await vendorJobFor(env.DB, order.id);
        printer = current ? `; printer NOT changed: the job is already ${current.status} with printer #${current.vendor_id}` : "; printer NOT recorded";
      }
    } catch (err) {
      console.error("vendor job not recorded", id, err);
      printer = `; printer NOT recorded (${err instanceof Error ? err.message : String(err)})`;
    }
  }
  const summary = `${pln}${conversion?.shown ?? ""} recorded for order ${row.order_id}${printer}`;
  if (!(await deliver(env, row))) {
    return `#${id} approved${conversion || vendor || printer ? ` (${summary})` : ""}, but the agent could not be told. Send /resend ${id} to retry.`;
  }
  return `#${id}: ${summary}.`;
}

/** Re-sends a decided escalation the agent has not been told about. */
export async function resend(env: Env, id: number): Promise<string> {
  const row = await getEscalation(env.DB, id);
  if (!row) return `#${id} doesn't exist.`;
  if (row.status === "open") return `#${id} is still open.`;
  if (row.delivered_at !== null) return `#${id} was already delivered to the agent.`;
  return (await deliver(env, row))
    ? `#${id} re-sent to the agent (${word(row.kind, row.status)}).`
    : `#${id}: the agent could not be told. Try /resend ${id} again later.`;
}

/**
 * After /printed: opens this order's printer milestones that wait for it, marks its printer job printed, and tells the treasury.
 * Returns a line for the owner ("" when nothing was waiting).
 */
async function releaseMilestones(env: Env, orderId: number, now: Date): Promise<string> {
  const lines: string[] = [];
  for (const ob of await waitingVendorObligations(env.DB, orderId)) {
    if (!(await setObligationStatus(env.DB, ob.id, ["waiting"], "open"))) continue;
    const due = `${formatUnits(ob.amount_units)} ${ob.token}`;
    // Printed before the owner decided a late deposit: the treasury holds this milestone until that decision (pay_obligation).
    const held = (await vendorObligations(env.DB, orderId)).find((o) => o.id !== ob.id && o.status === "escalated");
    const decideFirst = held ? await openEscalationFor(env.DB, held.id) : null;
    const then = !held
      ? "the treasury pays it"
      : `the printer's second milestone is held until ${decideFirst !== null ? `you decide #${decideFirst}` : `milestone #${held.id} is decided`}`;
    lines.push(`Printer #${ob.vendor_id}'s milestone #${ob.id} (${due}) is now due; ${then}.`);
    try {
      const wait = held ? ` It is held while milestone #${held.id} waits for the owner's decision.` : "";
      await (await getAgentByName(env.TreasuryAgent, TREASURY_NAME)).notify(`Order ${orderId} printed: milestone obligation #${ob.id} (${due} to printer #${ob.vendor_id}) is now due.${wait}`);
    } catch (err) {
      // The treasury still sees the open milestone in its next snapshot.
      console.error("could not tell the treasury a milestone is due", ob.id, err);
    }
  }
  await markJob(env.DB, orderId, "printed", now);
  return lines.join(" ");
}

/** releaseMilestones for /printed's reply: a failure is logged and the owner is asked to send /printed again, which retries it. */
async function releaseOrSay(env: Env, orderId: number, now: Date): Promise<string> {
  try {
    return await releaseMilestones(env, orderId, now);
  } catch (err) {
    console.error("could not release the printer's second milestone", orderId, err);
    return `The printer's second milestone wasn't released; send /printed ${orderId} again.`;
  }
}

/** The owner reports the printer finished: request the balance (or mark the order paid when nothing is left), and open the printer's second milestone. */
export async function markPrinted(env: Env, n: number, now: Date = new Date()): Promise<string> {
  const order = await getOrderById(env.DB, n);
  if (!order) return `Order ${n} doesn't exist.`;
  if (order.status !== "deposit_paid") {
    // Printed already, but a milestone still waits: the first /printed stopped after the status move. Open it now.
    const released = PRINTED_STATUSES.includes(order.status) ? await releaseMilestones(env, n, now) : "";
    if (released) return `Order ${n} was already printed. ${released}`;
    return `Order ${n} is ${order.status}; /printed works once the deposit is paid.`;
  }
  const quote = await acceptedQuote(env.DB, n);
  if (!quote) return `Order ${n} has no accepted quote.`;
  const agent = await getAgentByName(env.OrderAgent, order.instance);
  const balanceCents = quote.price_cents - quote.deposit_cents;
  if (balanceCents <= 0) {
    if (!(await setOrderStatus(env.DB, n, ["deposit_paid"], "balance_paid"))) return `Order ${n} changed; try again.`;
    const released = await releaseOrSay(env, n, now);
    await agent.pushEvent('The owner reports the job is printed. Nothing more is due. When the swag arrives, ask the host to press "We received it" on the order page.', "Printing done. Nothing more is due.");
    return `Order ${n}: printed; nothing more is due.${released ? ` ${released}` : ""}`;
  }
  // Due before delivery, but never less than a day away.
  const dueBy = new Date(Math.max(Date.parse(order.deliver_by), now.getTime() + 24 * 3_600_000));
  const request = await createPaymentRequest(env.DB, { orderId: n, quoteId: quote.id, stage: "balance", token: TOKEN_FOR[quote.currency], cents: balanceCents, dueBy }, now);
  if (!(await setOrderStatus(env.DB, n, ["deposit_paid"], "balance_pending"))) return `Order ${n} changed; try again.`;
  const released = await releaseOrSay(env, n, now);
  const amount = `${formatUnits(request.amount_units)} ${request.token}`;
  await agent.pushEvent(
    `The owner reports the job is printed. Balance request #${request.id}: ${amount} on Arc, due by ${warsawTime(new Date(request.due_by))} (Warsaw time). Tell the host the balance is on the order page.`,
    `Printing done. Balance due: ${amount}.`,
  );
  try {
    await agent.remindLater(new Date(Date.parse(request.due_by) - 12 * 3_600_000).toISOString(), { kind: "payment", id: request.id });
  } catch (err) {
    console.error("could not schedule the balance reminder", err);
  }
  return `Order ${n}: printed; balance request #${request.id} for ${amount} is on the order page.${released ? ` ${released}` : ""}`;
}

const parseId = (arg: string | undefined): number | null => (arg !== undefined && /^\d{1,9}$/.test(arg) ? Number(arg) : null);

const VENDOR_LIST_MAX = 20;
const VENDOR_USAGE = "Usage: /vendor <#> partner|screened|paused, or /vendor <#> pay <0x address> <CHAIN>";

function methodList(v: VendorRow): string {
  try {
    const m: unknown = JSON.parse(v.methods);
    return Array.isArray(m) && m.length > 0 ? m.map(String).join(", ") : "no methods";
  } catch {
    return "no methods";
  }
}

/** Up to 20 printers, partners first, then screened, candidates and paused; `place` may be a city name or alias. */
async function vendorList(env: Env, place: string): Promise<string> {
  const city = place ? (cityFromPlace(place) ?? place) : undefined;
  const rows: VendorRow[] = [];
  // One more than shown says whether there are more.
  for (const status of ["partner", "screened", "candidate", "paused"] as const) {
    if (rows.length > VENDOR_LIST_MAX) break;
    rows.push(...(await listVendors(env.DB, { city, statuses: [status], limit: VENDOR_LIST_MAX + 1 - rows.length })));
  }
  if (rows.length === 0) return city ? `No printers in ${city}.` : "No printers yet.";
  const lines = await Promise.all(rows.slice(0, VENDOR_LIST_MAX).map(async (v) => {
    const score = await vendorScore(env.DB, v.id);
    return `#${v.id} ${v.status} · ${v.name} · ${v.city} · ${methodList(v)} · ${score.jobs} jobs, ${score.onTime} on time · ${v.email ?? "no email"}`;
  }));
  if (rows.length > VENDOR_LIST_MAX) lines.push(city ? `(first ${VENDOR_LIST_MAX} shown)` : `(first ${VENDOR_LIST_MAX} shown; narrow it: /vendors <city>)`);
  return lines.join("\n");
}

/** `/vendor <#> partner|screened|paused` or `/vendor <#> pay <0x address> <CHAIN>`. */
async function vendorCommand(env: Env, args: string[]): Promise<string> {
  const id = parseId(args[0]);
  if (id === null || id <= 0) return VENDOR_USAGE;
  const action = (args[1] ?? "").toLowerCase();
  if (action === "pay") {
    // Where the treasury sends this printer's money: nothing ambiguous is accepted.
    const address = args[2];
    const chain = (args[3] ?? "").toUpperCase();
    if (args.length !== 4 || !isAddress(address) || !/^[A-Z][A-Z0-9-]{1,23}$/.test(chain)) return VENDOR_USAGE;
    const lower = address.toLowerCase();
    const result = await setVendorPayout(env.DB, id, lower, chain);
    if (result === "missing") return `Printer #${id} doesn't exist.`;
    if (result === "not_partner") return `Printer #${id} must be a partner first: /vendor ${id} partner`;
    return `Printer #${id} is paid at ${lower} on ${chain}.`;
  }
  if (action !== "partner" && action !== "screened" && action !== "paused") return VENDOR_USAGE;
  const status: VendorStatus = action;
  const before = await getVendor(env.DB, id);
  if (!before || !(await setVendorStatus(env.DB, id, status))) return `Printer #${id} doesn't exist.`;
  const cleared = status !== "partner" && before.payout_address !== null;
  return `Printer #${id} is now ${status}.${cleared ? ` Its payout address was cleared: after /vendor ${id} partner, register it again with /vendor ${id} pay.` : ""}`;
}

async function openList(env: Env): Promise<string> {
  const [open, undelivered] = await Promise.all([listEscalations(env.DB, { status: "open", limit: 20 }), listUndelivered(env.DB)]);
  if (open.length === 0 && undelivered.length === 0) return "No open escalations.";
  return [
    ...open.map((e) => `#${e.id} · ${e.order_id === null ? "no order" : `order ${e.order_id}`} · ${e.kind} · ${e.summary.slice(0, 120)}`),
    ...undelivered.map((e) => `#${e.id} ${word(e.kind, e.status)} — agent not told yet: /resend ${e.id}`),
  ].join("\n");
}

async function orderStatus(env: Env, n: number): Promise<string> {
  const order = await getOrderById(env.DB, n);
  if (!order) return `Order ${n} doesn't exist.`;
  const agent = await getAgentByName(env.OrderAgent, order.instance);
  const view = await agent.getView();
  return [
    `Order ${order.id} · ${order.event_name} · ${order.status}`,
    `Deliver by ${order.deliver_by} to ${order.delivery_place}`,
    `Still missing: ${view.missing.join("; ") || "nothing"}`,
    `Messages: ${view.thread.length}`,
  ].join("\n");
}

export async function handleTelegram(request: Request, env: Env, deps: { telegram?: TelegramClient; fetch?: typeof fetch } = {}): Promise<Response> {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return new Response("not configured", { status: 404 });
  if (!sameSecret(request.headers.get("x-telegram-bot-api-secret-token") ?? "", secret)) {
    return new Response("unauthorized", { status: 401 });
  }
  const owner = env.TELEGRAM_OWNER_CHAT_ID;
  const telegram = deps.telegram ?? createTelegram(env.TELEGRAM_BOT_TOKEN);
  let update: Update;
  try {
    update = (await request.json()) as Update;
  } catch {
    return new Response("ok");
  }
  const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
  if (!owner || chatId === undefined || String(chatId) !== owner) return new Response("ok");
  const reply = async (text: string) => {
    try {
      await telegram.send(owner, text);
    } catch (err) {
      console.error("telegram reply failed", err);
    }
  };

  const cb = update.callback_query;
  if (cb?.data) {
    const m = /^esc:(\d+):(approve|reject)$/.exec(cb.data);
    let text = "Unknown button.";
    if (m) {
      try {
        text = await decide(env, Number(m[1]), m[2] === "approve" ? "approved" : "rejected", null);
      } catch (err) {
        console.error("telegram button failed", err);
        text = "Something went wrong; try /approve or /reject.";
      }
    }
    if (cb.id) {
      try {
        await telegram.answerCallback(cb.id, text);
      } catch (err) {
        console.error("telegram answerCallback failed", err);
      }
    }
    // The toast disappears; the chat keeps a record of every button press.
    await reply(text);
    return new Response("ok");
  }

  const words = (update.message?.text ?? "").trim().split(/\s+/);
  const command = (words[0] ?? "").replace(/@\w+$/, "");
  const arg = words[1];
  const note = words.slice(2).join(" ").trim().slice(0, 1000) || null;
  try {
    switch (command) {
      case "/open":
        await reply(await openList(env));
        break;
      case "/approve":
      case "/reject": {
        const id = parseId(arg);
        await reply(id !== null && id > 0
          ? await decide(env, id, command === "/approve" ? "approved" : "rejected", note)
          : `Usage: ${command} <id> [note]`);
        break;
      }
      case "/resend": {
        const id = parseId(arg);
        await reply(id !== null && id > 0 ? await resend(env, id) : "Usage: /resend <id>");
        break;
      }
      case "/cost": {
        const id = parseId(arg);
        const cost = id !== null && id > 0 ? parseCostArgs(words.slice(2), id) : null;
        if (id === null || cost === null || "error" in cost) {
          await reply(cost && "error" in cost ? cost.error : COST_USAGE);
          break;
        }
        await reply(await giveCost(env, id, cost.amount, cost.note, { currency: cost.currency, vendorId: cost.vendorId, fetchImpl: deps.fetch }));
        break;
      }
      case "/vendors":
        await reply(await vendorList(env, words.slice(1).join(" ")));
        break;
      case "/vendor":
        await reply(await vendorCommand(env, words.slice(1)));
        break;
      case "/order": {
        const n = parseId(arg);
        await reply(n !== null && n > 0 ? await orderStatus(env, n) : "Usage: /order <number>");
        break;
      }
      case "/printed": {
        const n = parseId(arg);
        await reply(n !== null && n > 0 ? await markPrinted(env, n) : "Usage: /printed <order number>");
        break;
      }
      default:
        await reply(HELP);
    }
  } catch (err) {
    console.error("telegram command failed", command, err);
    await reply(`Something went wrong: ${err instanceof Error ? err.message : String(err)}`);
  }
  return new Response("ok");
}
