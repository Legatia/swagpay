import { adminWarningsFull, moneySummary, ORDERS_PER_PAGE, orderLedger, ordersPage, suppliersPage, toPayRows } from "./admin-data";
import { layout, renderLedger, renderOrders, renderSuppliers, renderToday } from "./admin-views";
import { handleAdminPost } from "./admin-actions";
import { verifyAccessJwt } from "./access";
import type { RpcClient } from "./arc";
import { listEscalations } from "./escalations";

export { adminWarnings, configWarnings, esc } from "./admin-util";

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-robots-tag": "noindex",
  // same-origin, not no-referrer: with no-referrer a browser sends "Origin: null" on form POSTs, which the Origin check refuses.
  "referrer-policy": "same-origin",
};
const html = (body: string, status = 200) => new Response(body, { status, headers: HEADERS });

export interface AdminDeps {
  fetch?: typeof fetch;
  rpc?: Pick<RpcClient, "erc20Balance">;
}

export async function handleAdmin(request: Request, env: Env, deps: AdminDeps = {}): Promise<Response> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return new Response("Admin is not configured.", { status: 503 });
  const who = await verifyAccessJwt(request.headers.get("cf-access-jwt-assertion"), env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD, deps.fetch);
  if (!who) return new Response("Forbidden", { status: 403 });
  if (request.method === "POST") return handleAdminPost(request, env, { email: who.email ?? null });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD, POST" } });
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const msg = url.searchParams.get("msg")?.slice(0, 200) ?? null;
  const email = who.email ?? null;
  const notFound = () => html(layout("Not found", email, null, "<h1>Not found</h1>"), 404);

  if (path === "/admin") {
    const [rows, summary, warnings, open] = await Promise.all([
      toPayRows(env.DB),
      moneySummary(env, deps.rpc),
      adminWarningsFull(env),
      listEscalations(env.DB, { status: "open", limit: 100 }),
    ]);
    return html(renderToday({ rows, summary, warnings, open, who: email, msg }));
  }
  if (path === "/admin/orders") {
    const raw = url.searchParams.get("page");
    const page = raw === null ? 0 : /^\d{1,6}$/.test(raw) ? Number(raw) : 0;
    return html(renderOrders(await ordersPage(env.DB, page * ORDERS_PER_PAGE), page, email, msg, ORDERS_PER_PAGE));
  }
  const m = /^\/admin\/orders\/(\d{1,12})$/.exec(path);
  if (m) {
    const ledger = await orderLedger(env.DB, Number(m[1]));
    return ledger ? html(renderLedger(ledger, env.ARC_EXPLORER_URL, email, msg)) : notFound();
  }
  if (path === "/admin/suppliers") return html(renderSuppliers(await suppliersPage(env.DB), email, msg));
  return notFound();
}
