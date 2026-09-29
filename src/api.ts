import { getAgentByName } from "agents";
import { countOrdersSince, createOrder, deleteOrder, getOrderByToken, type OrderRow } from "./db";
import { newFileId } from "./ids";
import { IntakeSchema, checkIntakeDates, issueText } from "./intake";
import type { ArtworkMeta } from "./agent/order-agent";
import { sniffMediaType } from "./sniff";
import { verifyTurnstile } from "./turnstile";

export const MAX_UPLOAD_BYTES = 10_000_000;
export const MAX_FILES_PER_ORDER = 10;
export const UPLOAD_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml", "application/pdf"];

export interface ApiDeps {
  verifyHuman?: (token: unknown, ip: string | null) => Promise<boolean>;
}

const json = (status: number, body: unknown, headers?: HeadersInit) => Response.json(body, { status, headers });
const NO_STORE = { "cache-control": "no-store" };

let warnedCap = false;
function orderCap(env: Env): number {
  const n = Number(env.MAX_NEW_ORDERS_PER_DAY);
  if (Number.isFinite(n) && n > 0) return n;
  if (!warnedCap) {
    warnedCap = true;
    console.warn("MAX_NEW_ORDERS_PER_DAY is missing or invalid; using 20");
  }
  return 20;
}
const fail = (status: number, error: string) => json(status, { error });

async function readJson(request: Request): Promise<unknown | undefined> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function publicOrder(o: OrderRow) {
  return {
    number: o.id,
    eventName: o.event_name,
    eventDate: o.event_date,
    deliverBy: o.deliver_by,
    deliveryPlace: o.delivery_place,
    status: o.status,
  };
}

export async function handleApi(request: Request, env: Env, deps: ApiDeps = {}): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/config" && request.method === "GET") {
    return json(200, { turnstileSiteKey: env.TURNSTILE_SITE_KEY || null });
  }

  if (path === "/api/orders" && request.method === "POST") {
    const body = await readJson(request);
    if (body === undefined) return fail(400, "body must be JSON");
    if (String(env.REQUIRE_TURNSTILE) !== "0") {
      const secret = env.TURNSTILE_SECRET;
      const verifyHuman = deps.verifyHuman ?? (secret ? (token: unknown, ip: string | null) => verifyTurnstile(token, ip, secret) : async () => false);
      if (!(await verifyHuman((body as { turnstile?: unknown } | null)?.turnstile, request.headers.get("cf-connecting-ip")))) {
        return fail(403, "Please complete the human check and try again.");
      }
    }
    const parsed = IntakeSchema.safeParse(body);
    if (!parsed.success) return fail(400, issueText(parsed.error));
    const now = new Date();
    const dateProblem = checkIntakeDates(parsed.data, now);
    if (dateProblem) return fail(400, dateProblem);
    const cap = orderCap(env);
    if ((await countOrdersSince(env.DB, new Date(now.getTime() - 86_400_000))) >= cap) {
      return fail(429, "Swagpay is taking as many new orders as it can today. Please try again tomorrow.");
    }
    const { order, token } = await createOrder(env.DB, parsed.data, now);
    try {
      const agent = await getAgentByName(env.OrderAgent, order.instance);
      await agent.init(order.id, parsed.data);
    } catch (err) {
      await deleteOrder(env.DB, order.id);
      throw err;
    }
    return json(201, { token, url: `/o/${token}` }, NO_STORE);
  }

  const m = /^\/api\/o\/([A-Za-z0-9_-]{43})(\/messages|\/artwork)?$/.exec(path);
  if (!m) return fail(404, "not found");
  const order = await getOrderByToken(env.DB, m[1]);
  if (!order) return fail(404, "order not found");
  const agent = await getAgentByName(env.OrderAgent, order.instance);
  const sub = m[2];

  if (!sub && request.method === "GET") {
    return json(200, { order: publicOrder(order), view: await agent.getView() }, NO_STORE);
  }

  if (sub === "/messages" && request.method === "POST") {
    const body = (await readJson(request)) as { text?: unknown } | undefined;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return fail(400, "text is required");
    if (text.length > 4000) return fail(400, "messages can be up to 4,000 characters");
    try {
      return json(201, { entry: await agent.postHostMessage(text) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("message limit reached")) return fail(429, "This order has reached its message limit. The owner will contact you.");
      throw err;
    }
  }

  if (sub === "/artwork" && request.method === "POST") {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return fail(400, "send the file as multipart form data");
    }
    const file = form.get("file");
    if (!(file instanceof File)) return fail(400, "file is required");
    if (!UPLOAD_TYPES.includes(file.type)) return fail(400, "send PNG, JPEG, WebP, GIF, SVG or PDF");
    if (file.size > MAX_UPLOAD_BYTES) return fail(413, "files can be up to 10 MB");
    const view = await agent.getView();
    if (view.artwork.length >= MAX_FILES_PER_ORDER) return fail(400, "an order can have up to 10 files");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length === 0) return fail(400, "the file is empty");
    if (sniffMediaType(bytes) !== file.type) {
      return fail(400, "the file's content doesn't match its type; export it again as PNG, JPEG, WebP, GIF, SVG or PDF");
    }
    const fileId = newFileId();
    const key = `artwork/${order.instance}/${fileId}`;
    await env.ARTWORK.put(key, bytes, { httpMetadata: { contentType: file.type } });
    const meta: ArtworkMeta = {
      fileId,
      name: file.name.slice(0, 120),
      mediaType: file.type,
      size: file.size,
      key,
      at: new Date().toISOString(),
    };
    try {
      await agent.addArtwork(meta);
    } catch (err) {
      await env.ARTWORK.delete(key);
      throw err;
    }
    return json(201, { fileId });
  }

  return fail(405, "method not allowed");
}
