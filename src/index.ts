import { OrderAgent } from "./agent/order-agent";
import { handleApi } from "./api";

export { OrderAgent };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return Response.json({ ok: true });
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env);
      } catch (err) {
        console.error("api error", err);
        return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
      }
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
