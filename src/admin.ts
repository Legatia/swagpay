import { verifyAccessJwt } from "./access";
import { listRecentOrders, type OrderRow } from "./db";
import { listEscalations, type EscalationRow } from "./escalations";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export function renderAdmin(open: EscalationRow[], orders: OrderRow[], email: string | null): string {
  const escRows = open.length
    ? open.map((e) => `<tr><td>#${e.id}</td><td>${e.order_id ?? "—"}</td><td>${esc(e.kind)}</td><td>${esc(e.summary)}</td><td>${esc(e.created_at)}</td></tr>`).join("")
    : `<tr><td colspan="5">No open escalations.</td></tr>`;
  const orderRows = orders
    .map((o) => `<tr><td>${o.id}</td><td>${esc(o.event_name)}</td><td>${esc(o.deliver_by)}</td><td>${esc(o.status)}</td><td>${esc(o.created_at)}</td></tr>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Admin · Swagpay</title>
<link rel="stylesheet" href="/app.css"></head>
<body><main>
<span class="label">Admin${email ? ` · ${esc(email)}` : ""}</span>
<h1>Owner queue</h1>
<p class="muted">Decide escalations in Telegram: tap Approve or Reject, or send /approve &lt;id&gt; [note] or /reject &lt;id&gt; [note].</p>
<section class="sheet"><h2>Open escalations</h2><div style="overflow-x:auto"><table><thead><tr><th>#</th><th>Order</th><th>Kind</th><th>Summary</th><th>Created</th></tr></thead><tbody>${escRows}</tbody></table></div></section>
<section class="sheet"><h2>Recent orders</h2><div style="overflow-x:auto"><table><thead><tr><th>#</th><th>Event</th><th>Deliver by</th><th>Status</th><th>Created</th></tr></thead><tbody>${orderRows}</tbody></table></div></section>
</main></body></html>`;
}

export async function handleAdmin(request: Request, env: Env, deps: { fetch?: typeof fetch } = {}): Promise<Response> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return new Response("Admin is not configured.", { status: 503 });
  const who = await verifyAccessJwt(request.headers.get("cf-access-jwt-assertion"), env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD, deps.fetch);
  if (!who) return new Response("Forbidden", { status: 403 });
  const [open, orders] = await Promise.all([listEscalations(env.DB, { status: "open", limit: 100 }), listRecentOrders(env.DB, 50)]);
  return new Response(renderAdmin(open, orders, who.email), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
      "referrer-policy": "no-referrer",
    },
  });
}
