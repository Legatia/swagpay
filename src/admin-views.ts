import { esc } from "./admin-util";
import { PAY_CURRENCIES } from "./back-office";
import { toPayState, type Ledger, type MoneySummary, type OrderListRow, type SupplierListRow, type ToPayRow } from "./admin-data";
import type { EscalationRow } from "./escalations";
import { statusWord } from "./escalations";
import { formatCents } from "./money";

/** 257500000 → "257.50 USDC" (two decimals for reading; the ledger's detail keeps full units where it matters). */
export const money = (units: number, token: string) => `${(units / 1_000_000).toFixed(2)} ${token}`;
export const cents = (c: number, currency: string) => `${formatCents(c)} ${currency}`;
export const when = (iso: string | null) => (iso ? esc(iso.slice(0, 16).replace("T", " ")) : "—");
export const txLink = (explorer: string, hash: string) =>
  `<a class="mono" href="${esc(`${explorer.replace(/\/+$/, "")}/tx/${hash}`)}" rel="noreferrer">${esc(hash.slice(0, 10))}…</a>`;

/** A one-button form. `back` is where the action redirects; fields are hidden inputs. */
export function postButton(action: string, label: string, back: string, fields: Record<string, string> = {}, cls = ""): string {
  const hidden = Object.entries({ back, ...fields }).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
  return `<form method="post" action="${esc(action)}" class="inline">${hidden}<button${cls ? ` class="${cls}"` : ""}>${esc(label)}</button></form>`;
}

export function layout(title: string, who: string | null, msg: string | null, body: string): string {
  return `<!doctype html>
<html lang="en" class="light">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<meta name="color-scheme" content="light"><title>${esc(title)} · Swagpay admin</title>
<link rel="icon" type="image/svg+xml" href="/mark.svg">
<link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/admin.css"></head>
<body class="admin"><main>
<nav class="admin-nav"><a href="/admin">Today</a><a href="/admin/orders">Orders</a><a href="/admin/suppliers">Printers</a><span class="label">${who ? esc(who) : ""}</span></nav>
${msg ? `<p class="flash">${esc(msg)}</p>` : ""}
${body}
</main></body></html>`;
}

const table = (head: string[], rows: string[], empty: string) =>
  `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.length ? rows.join("") : `<tr><td colspan="${head.length}">${esc(empty)}</td></tr>`}</tbody></table></div>`;
const orderLink = (id: number) => `<a href="/admin/orders/${id}">#${id}</a>`;
const field = (name: string, label: string, attrs = "") => `<input name="${name}" placeholder="${label}" aria-label="${label}"${attrs}>`;

function paidForm(r: ToPayRow, back: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const confirm = r.payment.status === "cashing_out" ? `<label><input type="checkbox" name="confirm" value="1"> money has arrived</label>` : "";
  return `<form method="post" action="/admin/payments/${r.payment.id}/paid" class="inline"><input type="hidden" name="back" value="${esc(back)}">
<select name="method" aria-label="Method"><option>card</option><option>blik</option><option>transfer</option></select>
${field("reference", "Reference")}<input type="date" name="date" value="${today}" aria-label="Date">${confirm}<button>Paid</button></form>`;
}

function cancelForm(r: ToPayRow, back: string): string {
  return `<form method="post" action="/admin/payments/${r.payment.id}/cancel" class="inline"><input type="hidden" name="back" value="${esc(back)}">${field("note", "Note")}<button class="secondary">Cancel</button></form>`;
}

function toPayActions(r: ToPayRow, actions: string[], back: string): string {
  const out: string[] = [];
  for (const a of actions) {
    if (a === "cashout") out.push(postButton(`/admin/payments/${r.payment.id}/cashout`, "Cash out", back));
    else if (a === "retry" && r.cashout) out.push(postButton(`/admin/cashouts/${r.cashout.id}/retry`, "Retry withdrawal", back));
    else if (a === "paid") out.push(paidForm(r, back));
    else if (a === "cancel") out.push(cancelForm(r, back));
  }
  return out.join("<br>");
}

function escalationRow(e: EscalationRow, back: string): string {
  const approve = e.kind === "cost"
    ? (e.order_id !== null ? `<a href="/admin/orders/${e.order_id}">Set the price on the order page</a>` : "")
    : `<button name="decision" value="approve">Approve</button>`;
  const form = `<form method="post" action="/admin/escalations/${e.id}/decide" class="inline"><input type="hidden" name="back" value="${esc(back)}">${field("note", "Note")}${e.kind === "cost" ? "" : approve}<button name="decision" value="reject" class="secondary">Reject</button></form>`;
  return `<tr><td>#${e.id}</td><td>${e.order_id !== null ? orderLink(e.order_id) : "—"}</td><td>${esc(e.kind)}</td><td>${esc(e.summary)}</td><td>${form}${e.kind === "cost" ? `<br>${approve}` : ""}</td></tr>`;
}

export function renderToday(p: { rows: ToPayRow[]; summary: MoneySummary; warnings: string[]; open: EscalationRow[]; who: string | null; msg: string | null }): string {
  const back = "/admin";
  const payRows = p.rows.map((r) => {
    const state = toPayState(r);
    const how = r.payment.status === "ready" && r.vendor?.how_to_pay ? `<div class="how">${esc(r.vendor.how_to_pay)}</div>` : "";
    return `<tr><td>${orderLink(r.order.id)}</td><td>${esc(r.order.event_name)}</td><td>${r.vendor ? esc(r.vendor.name) : "—"}</td><td>${esc(cents(r.payment.amount_cents, r.payment.currency))}</td><td>${when(r.order.deliver_by)}</td><td class="status">${esc(state.label)}${how}</td><td>${toPayActions(r, state.actions, back)}</td></tr>`;
  });
  const s = p.summary;
  const bal = (v: number | null, token: string) => (v === null ? "unknown" : money(v, token));
  const list = (items: string[]) => (items.length ? items.join(", ") : "nothing");
  const glance = `<ul>
<li>Agent wallet: ${esc(bal(s.usdc, "USDC"))}, ${esc(bal(s.eurc, "EURC"))}</li>
<li>At Kraken, not cashed out: ${esc(money(s.atKrakenUnits, "USDC"))}</li>
<li>Customers still owe: ${esc(list(s.customersOwe.map((c) => money(c.units, c.token))))}</li>
<li>You owe printers: ${esc(list(s.oweSuppliers.map((c) => cents(c.cents, c.currency))))}</li>
</ul>`;
  const body = `${p.warnings.map((w) => `<p class="error">${esc(w)}</p>`).join("\n")}
<h1>Today</h1>
<section><h2>To pay</h2>${table(["Order", "Event", "Printer", "Amount", "Deliver by", "Status", "Actions"], payRows, "Nothing to pay.")}</section>
<section><h2>Decisions waiting for you</h2>${table(["#", "Order", "Kind", "Summary", "Decide"], p.open.map((e) => escalationRow(e, back)), "Nothing waiting.")}</section>
<section><h2>Money at a glance</h2>${glance}</section>`;
  return layout("Today", p.who, p.msg, body);
}

export function renderOrders(rows: OrderListRow[], page: number, who: string | null = null, msg: string | null = null, perPage = 50): string {
  const trs = rows.map((o) => {
    const margin = o.cost_units > 0 && o.token ? money(o.received_units - o.cost_units, o.token) : "—";
    return `<tr><td>${orderLink(o.id)}</td><td>${esc(o.event_name)}</td><td>${esc(o.contact_name)}</td><td class="status">${esc(o.status)}</td><td>${o.price_cents !== null && o.currency ? esc(cents(o.price_cents, o.currency)) : "—"}</td><td>${o.token ? esc(money(o.received_units, o.token)) : "—"}</td><td>${o.printer ? esc(o.printer) : "—"}</td><td>${o.cost_pln_grosze !== null ? esc(cents(o.cost_pln_grosze, "PLN")) : "—"}</td><td>${esc(margin)}</td><td>${o.printer_paid ? (o.printer_paid === "paid" ? "yes" : "no") : "—"}</td></tr>`;
  });
  const nav = `<p>${page > 0 ? `<a href="/admin/orders?page=${page - 1}">Newer</a> ` : ""}${rows.length === perPage ? `<a href="/admin/orders?page=${page + 1}">Older</a>` : ""}</p>`;
  return layout("Orders", who, msg, `<h1>Orders</h1>${table(["Order", "Event", "Customer", "Status", "Price", "Received", "Printer", "Printer cost", "Margin", "Printer paid"], trs, "No orders.")}${nav}`);
}

export function renderLedger(l: Ledger, explorer: string, who: string | null = null, msg: string | null = null): string {
  const o = l.order;
  const customer = `<ul><li>${esc(o.contact_name)} &lt;${esc(o.contact_email)}&gt;</li><li>${esc(o.event_name)}, ${esc(o.event_date)}</li><li>${esc(o.delivery_place)}</li><li>Deliver by ${when(o.deliver_by)}</li><li>Status: ${esc(o.status)}</li></ul>`;
  const quotes = table(["#", "Price", "Deposit", "Cost PLN", "PLN/unit", "USD/unit", "Markup", "Status", "Valid until"],
    l.quotes.map((q) => `<tr><td>${q.id}</td><td>${esc(cents(q.price_cents, q.currency))}</td><td>${esc(cents(q.deposit_cents, q.currency))}</td><td>${esc(cents(q.cost_pln_grosze, "PLN"))}</td><td>${q.pln_per_unit}</td><td>${q.usd_per_unit}</td><td>${q.markup}</td><td>${esc(q.status)}</td><td>${when(q.valid_until)}</td></tr>`), "No quotes.");
  const moneyIn = l.requests.length
    ? l.requests.map((r) => {
      const ts = l.transfers.filter((t) => t.request_id === r.id);
      const tr = ts.map((t) => `<tr><td colspan="2" class="mono">${esc(t.from_address)}</td><td>${esc(money(t.amount_units, t.token))}</td><td>${when(t.created_at)}</td><td>${esc(t.via ?? "—")}</td><td>${txLink(explorer, t.tx_hash)}</td></tr>`);
      return table(["Stage", "Due", "Paid", "Token", "Status", "Due by"], [`<tr><td>${esc(r.stage)}</td><td>${esc(money(r.amount_units, r.token))}</td><td>${esc(money(r.paid_units, r.token))}</td><td>${esc(r.token)}</td><td>${esc(r.status)}</td><td>${when(r.due_by)}</td></tr>`], "")
        + table(["Payer", "", "Amount", "Time", "Matched by", "Transaction"], tr, "No transfers credited.");
    }).join("")
    : "<p>No payment requests.</p>";
  const orphan = l.transfers.filter((t) => !l.requests.some((r) => r.id === t.request_id));
  const job = l.job
    ? `<ul><li>${l.vendor ? esc(l.vendor.name) : "—"}, ${esc(l.job.status)}</li><li>Cost as given: ${esc(cents(l.job.cost_cents, l.job.cost_currency))}</li><li>Booked ${when(l.job.booked_at)}, printed ${when(l.job.printed_at)}, delivered ${when(l.job.delivered_at)}; on time: ${l.job.on_time === null ? "—" : l.job.on_time ? "yes" : "no"}</li></ul>`
    : "<p>No printer yet.</p>";
  const obs = l.obligations.map((ob) => {
    const ps = l.payouts.filter((p) => p.obligation_id === ob.id);
    const payoutCells = ps.length
      ? ps.map((p) => `${esc(p.status)}${p.result_ref ? ` <span class="mono">${esc(p.result_ref)}</span>` : ""}${p.error ? ` (${esc(p.error)})` : ""}`).join("<br>")
      : "—";
    return `<tr><td>${esc(ob.kind)}</td><td>${esc(ob.status)}</td><td>${esc(money(ob.amount_units, ob.token))}</td><td>${esc(ob.chain)}</td><td class="mono">${esc(ob.destination)}</td><td>${payoutCells}</td></tr>`;
  });
  const cashouts = table(["Cash-out", "Status", "Fiat", "USDC sold", "Kraken refs", "Fee", "Error"],
    l.cashouts.map((c) => `<tr><td>#${c.id}</td><td>${esc(c.status)}</td><td>${esc(cents(c.fiat_cents, c.fiat))}</td><td>${c.sold_units !== null ? esc(money(c.sold_units, "USDC")) : "—"}</td><td class="mono">${esc([c.order_ref, c.withdrawal_ref].filter(Boolean).join(" / ") || "—")}</td><td>${c.fee_cents !== null ? esc(cents(c.fee_cents, c.fiat)) : "—"}</td><td>${esc(c.error ?? "")}</td></tr>`), "No cash-outs.");
  const sp = l.payment
    ? `<ul><li>Printer payment: ${esc(cents(l.payment.amount_cents, l.payment.currency))}, ${esc(l.payment.status)}</li>${l.payment.status === "paid" ? `<li>${esc(l.payment.method ?? "—")}, reference ${esc(l.payment.reference ?? "—")}, ${when(l.payment.paid_at)}</li>` : ""}</ul>`
    : "<p>No printer payment yet.</p>";
  let margin = "<p>Not available.</p>";
  if (l.margin) {
    const q = l.quotes.find((x) => x.status === "accepted") ?? l.quotes[l.quotes.length - 1];
    const usd = (u: number, token: string) => (token === "EURC" ? u * (q?.usd_per_unit ?? 1) : u);
    const recv = usd(l.margin.receivedUnits, l.margin.token);
    const cost = l.margin.printerCostUnits;
    const fees = l.cashouts.filter((c) => c.fee_cents !== null).map((c) => cents(c.fee_cents ?? 0, c.fiat));
    margin = `<p>Estimate, in USD: received ${esc(money(recv, "USD"))}, printer cost ${esc(money(cost, "USD"))}, margin ${esc(money(recv - cost, "USD"))}.${fees.length ? ` Not included: withdrawal fee ${esc(fees.join(", "))}.` : ""}</p>`;
  }
  const history = table(["When", "Who", "What", "Result"], [
    ...l.decisions.map((d) => ({ at: d.created_at, who: "order agent", what: `${d.tool}: ${d.reason}`, res: `${d.verdict} / ${d.outcome}${d.detail ? `: ${d.detail}` : ""}` })),
    ...l.treasury.map((d) => ({ at: d.created_at, who: "treasury", what: `${d.tool}: ${d.reason}`, res: `${d.verdict} / ${d.outcome}${d.detail ? `: ${d.detail}` : ""}` })),
    ...l.escalations.map((e) => ({ at: e.created_at, who: `escalation #${e.id}`, what: `${e.kind}: ${e.summary}`, res: `${statusWord(e.kind, e.status)}${e.decision_note ? `: ${e.decision_note}` : ""}` })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1)).map((h) => `<tr><td>${when(h.at)}</td><td>${esc(h.who)}</td><td>${esc(h.what)}</td><td>${esc(h.res)}</td></tr>`), "Nothing yet.");
  const body = `<h1>Order #${o.id}</h1>
<section><h2>Customer</h2>${customer}</section>
<section><h2>Quotes</h2>${quotes}</section>
<section><h2>Money in</h2>${moneyIn}${orphan.length ? `<p>Transfers not attached to a request: ${orphan.length}.</p>` : ""}</section>
<section><h2>Printer</h2>${job}</section>
<section><h2>Money out</h2>${table(["Obligation", "Status", "Amount", "Chain", "Destination", "Payout"], obs, "No obligations.")}${cashouts}${sp}</section>
<section><h2>Margin</h2>${margin}</section>
<section><h2>History</h2>${history}</section>`;
  return layout(`Order #${o.id}`, who, msg, body);
}

function payForm(v: SupplierListRow): string {
  const opts = PAY_CURRENCIES.map((c) => `<option${c === v.pay_currency ? " selected" : ""}>${c}</option>`).join("");
  return `<form method="post" action="/admin/suppliers/${v.id}" class="inline"><input type="hidden" name="back" value="/admin/suppliers">
<select name="pay_currency" aria-label="Currency">${opts}</select><input name="how_to_pay" value="${esc(v.how_to_pay ?? "")}" placeholder="How to pay" aria-label="How to pay" maxlength="300"><button class="secondary">Save</button></form>`;
}

export function renderSuppliers(rows: SupplierListRow[], who: string | null = null, msg: string | null = null): string {
  const cities = [...new Set(rows.map((r) => r.city))];
  const body = `<h1>Printers</h1>` + (cities.length ? cities.map((city) => `<section><h2>${esc(city)}</h2>${table(["Name", "Status", "Currency", "How to pay", "Crypto payout", "Jobs", "On time", "Last job"],
    rows.filter((r) => r.city === city).map((v) => `<tr><td>${esc(v.name)}</td><td>${esc(v.status)}</td><td colspan="2">${payForm(v)}</td><td class="mono">${v.payout_address ? `${esc(v.payout_address)} (${esc(v.payout_chain ?? "?")})` : "—"}</td><td>${v.jobs}</td><td>${v.delivered ? `${v.on_time}/${v.delivered}` : "—"}</td><td>${when(v.last_job)}</td></tr>`), "")}</section>`).join("") : "<p>No printers.</p>");
  return layout("Printers", who, msg, body);
}
