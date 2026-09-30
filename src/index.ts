import { OrderAgent } from "./agent/order-agent";
import { TreasuryAgent } from "./agent/treasury-agent";
import { handleAdmin } from "./admin";
import { handleApi } from "./api";
import { computeMetrics, listPublicDecisions, renderLog } from "./public-log";
import { handleScheduled } from "./scheduled";
import { handleTelegram } from "./telegram-webhook";
import { handleTreasuryApi } from "./treasury-api";

export { OrderAgent, TreasuryAgent };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return Response.json({ ok: true });
    if (url.pathname === "/api/telegram" && request.method === "POST") {
      try {
        return await handleTelegram(request, env);
      } catch (err) {
        console.error("telegram webhook error", err);
        return new Response("ok");
      }
    }
    if (url.pathname.startsWith("/api/treasury/")) {
      try {
        return await handleTreasuryApi(request, env);
      } catch (err) {
        console.error("treasury api error", err);
        return Response.json({ error: "Something went wrong." }, { status: 500 });
      }
    }
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env);
      } catch (err) {
        console.error("api error", err);
        return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
      }
    }
    if (url.pathname === "/log" && request.method === "GET") {
      try {
        const [decisions, metrics] = await Promise.all([listPublicDecisions(env.DB), computeMetrics(env.DB)]);
        return new Response(renderLog(decisions, metrics), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } });
      } catch (err) {
        console.error("log error", err);
        return new Response("Something went wrong.", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
    }
    if (url.pathname === "/admin" || url.pathname === "/admin/") return handleAdmin(request, env);
    if (/^\/o\/[A-Za-z0-9_-]{43}$/.test(url.pathname)) {
      return env.ASSETS.fetch(new Request(new URL("/order", url), request));
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleScheduled(controller.cron, env, new Date(controller.scheduledTime)).catch((err) => console.error("scheduled run failed", controller.cron, err)));
  },
} satisfies ExportedHandler<Env>;
