import { OrderAgent } from "./agent/order-agent";

export { OrderAgent };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return Response.json({ ok: true });
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
