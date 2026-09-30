import { getAgentByName } from "agents";
import { countOrdersSince, createOrder, deleteOrder, getOrderByToken, setOrderStatus, type OrderRow } from "./db";
import { DesignSpecSchema, FILE_ROLES, MAX_DESIGN_BYTES, designProblems, type FileRole } from "./design-spec";
import { TREASURY_NAME } from "./agent/treasury-agent";
import { newFileId } from "./ids";
import { IntakeSchema, checkIntakeDates, issueText } from "./intake";
import type { ArtworkMeta } from "./agent/order-agent";
import { sniffMediaType } from "./sniff";
import { verifyTurnstile } from "./turnstile";
import { ratesFor } from "./fx";
import { computeMetrics, listPublicDecisions } from "./public-log";
import { TOKEN_FOR, formatCents, formatUnits, isAddress } from "./money";
import { addClaim, createPaymentRequest, findPaymentRequest, getPaymentRequest, listPaymentRequests, type PaymentRequestRow } from "./payments";
import { EMPTY_SPEC, itemsKey, type OrderSpec } from "./order-spec";
import { loadPolicy, quoteStillValid } from "./policy";
import { CREATE_KEY, completeCreateKey, intakeHash, lookupCreateKey, releaseCreateKey, reserveCreateKey, type KeyLookup } from "./order-create-keys";
import { acceptQuoteForOrder, expireQuote, getQuote, latestQuote, reopenQuote, supersedeQuote, type QuoteRow } from "./quotes";
import { markJob } from "./vendors";
import { handleSandboxOwner } from "./sandbox/owner-api";

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

/** The answer for a create key seen before, or null when it is new. */
function answerSeenKey(seen: KeyLookup): Response | null {
  if (seen.kind === "replay") return json(200, { token: seen.token, url: `/o/${seen.token}` }, NO_STORE);
  if (seen.kind === "conflict") return fail(409, "This idempotencyKey was already used for a different order.");
  if (seen.kind === "pending") return json(503, { error: "This order is still being created. Try again in a moment." }, { ...NO_STORE, "retry-after": "2" });
  return null;
}

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

function publicQuote(q: QuoteRow | null) {
  if (!q) return null;
  return { id: q.id, currency: q.currency, price: formatCents(q.price_cents), deposit: formatCents(q.deposit_cents), validUntil: q.valid_until, status: q.status };
}

function publicPayment(p: PaymentRequestRow) {
  return {
    id: p.id, stage: p.stage, token: p.token, amount: formatUnits(p.amount_units), paid: formatUnits(p.paid_units),
    due: formatUnits(Math.max(0, p.amount_units - p.paid_units)), status: p.status,
  };
}

function payTo(env: Env) {
  if (!isAddress(env.RECEIVING_ADDRESS)) return null;
  return { address: env.RECEIVING_ADDRESS, network: "Arc", chainId: Number(env.ARC_CHAIN_ID) || 5042, tokens: { USDC: env.USDC_ADDRESS, EURC: env.EURC_ADDRESS } };
}

export async function handleApi(request: Request, env: Env, deps: ApiDeps = {}): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/config" && request.method === "GET") {
    return json(200, { turnstileSiteKey: env.TURNSTILE_SITE_KEY || null });
  }

  if (path === "/api/log" && request.method === "GET") return json(200, { decisions: await listPublicDecisions(env.DB) }, { "cache-control": "public, max-age=60" });
  if (path === "/api/metrics" && request.method === "GET") return json(200, await computeMetrics(env.DB), { "cache-control": "public, max-age=60" });

  if (path === "/api/pricing" && request.method === "GET") {
    const now = new Date();
    const [usd, eur] = await Promise.all([ratesFor(env.DB, "USD", now), ratesFor(env.DB, "EUR", now)]);
    const policy = loadPolicy(env as unknown as Record<string, unknown>);
    const fresh = usd && eur;
    const at = fresh ? (await env.DB.prepare("SELECT MIN(fetched_at) AS at FROM fx_rates WHERE code IN ('USD', 'EUR')").first<{ at: string | null }>())?.at ?? null : null;
    return json(200, {
      plnPerUnit: fresh ? { USD: usd.plnPerUnit, EUR: eur.plnPerUnit } : null,
      fetchedAt: at, markupMin: policy.markupMin, markupMax: policy.markupMax, fxBuffer: policy.fxBuffer, perOrderCapUsd: policy.perOrderCapUsd,
    }, { "cache-control": "public, max-age=300" });
  }

  if (path === "/api/orders" && request.method === "POST") {
    const body = await readJson(request);
    if (body === undefined) return fail(400, "body must be JSON");
    const now = new Date();
    // A retried create with the same key gets the same order. Checked before the human check: a Turnstile token is single-use.
    const rawKey = (body as { idempotencyKey?: unknown } | null)?.idempotencyKey;
    let createKey: { key: string; hash: string } | null = null;
    if (rawKey !== undefined) {
      if (typeof rawKey !== "string" || !CREATE_KEY.test(rawKey)) return fail(400, "idempotencyKey: use 16 to 64 letters, digits, - or _");
      createKey = { key: rawKey, hash: await intakeHash(body as Record<string, unknown>) };
      const seen = answerSeenKey(await lookupCreateKey(env.DB, createKey.key, createKey.hash, now));
      if (seen) return seen;
    }
    if (String(env.REQUIRE_TURNSTILE) !== "0") {
      const secret = env.TURNSTILE_SECRET;
      const verifyHuman = deps.verifyHuman ?? (secret ? (token: unknown, ip: string | null) => verifyTurnstile(token, ip, secret) : async () => false);
      if (!(await verifyHuman((body as { turnstile?: unknown } | null)?.turnstile, request.headers.get("cf-connecting-ip")))) {
        return fail(403, "Please complete the human check and try again.");
      }
    }
    const parsed = IntakeSchema.safeParse(body);
    if (!parsed.success) return fail(400, issueText(parsed.error));
    const dateProblem = checkIntakeDates(parsed.data, now);
    if (dateProblem) return fail(400, dateProblem);
    const cap = orderCap(env);
    if ((await countOrdersSince(env.DB, new Date(now.getTime() - 86_400_000))) >= cap) {
      return fail(429, "Swagpay is taking as many new orders as it can today. Please try again tomorrow.");
    }
    // Only a create that passed every check claims its key, so a refused one can be corrected and retried.
    if (createKey && !(await reserveCreateKey(env.DB, createKey.key, createKey.hash, now))) {
      return answerSeenKey(await lookupCreateKey(env.DB, createKey.key, createKey.hash, now)) ?? fail(503, "Please try again.");
    }
    let created: { order: OrderRow; token: string };
    try {
      created = await createOrder(env.DB, parsed.data, now);
    } catch (err) {
      if (createKey) await releaseCreateKey(env.DB, createKey.key);
      throw err;
    }
    const { order, token } = created;
    try {
      const agent = await getAgentByName(env.OrderAgent, order.instance);
      await agent.init(order.id, parsed.data);
    } catch (err) {
      if (createKey) await releaseCreateKey(env.DB, createKey.key);
      await deleteOrder(env.DB, order.id);
      throw err;
    }
    if (createKey) await completeCreateKey(env.DB, createKey.key, order.id, token);
    return json(201, { token, url: `/o/${token}` }, NO_STORE);
  }

  const so = /^\/api\/o\/([A-Za-z0-9_-]{43})\/sandbox\/owner(?:\/([a-z]{1,20}))?$/.exec(path);
  if (so) return handleSandboxOwner(request, env, so[1], so[2] ?? null);

  const m = /^\/api\/o\/([A-Za-z0-9_-]{43})(\/messages|\/artwork|\/design|\/quote\/accept|\/received|\/payments\/(\d{1,9})\/claim)?$/.exec(path);
  if (!m) return fail(404, "not found");
  const order = await getOrderByToken(env.DB, m[1]);
  if (!order) return fail(404, "order not found");
  const agent = await getAgentByName(env.OrderAgent, order.instance);
  const sub = m[2];

  if (!sub && request.method === "GET") {
    const [view, quote, payments] = await Promise.all([agent.getView(), latestQuote(env.DB, order.id), listPaymentRequests(env.DB, order.id)]);
    return json(200, { order: publicOrder(order), view, quote: publicQuote(quote), payments: payments.map(publicPayment), payTo: payTo(env) }, NO_STORE);
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
    const rawRole = form.get("role");
    const role = rawRole === null ? "artwork" : String(rawRole);
    if (!(FILE_ROLES as readonly string[]).includes(role)) return fail(400, "role must be artwork, mockup, print or cutline");
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
      role: role as FileRole,
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

  if (sub === "/quote/accept" && request.method === "POST") {
    const body = (await readJson(request)) as { quoteId?: unknown } | undefined;
    const quote = typeof body?.quoteId === "number" && Number.isInteger(body.quoteId) ? await getQuote(env.DB, body.quoteId) : null;
    if (!quote || quote.order_id !== order.id) return fail(404, "quote not found");
    // A deposit request for this quote means an earlier acceptance got that far: reuse it, never create another.
    const existing = quote.status === "open" || quote.status === "accepted" ? await findPaymentRequest(env.DB, quote.id, "deposit") : null;
    if (existing && quote.status === "accepted") return json(201, { requestId: existing.id }, NO_STORE);
    if (quote.status !== "open") return fail(409, `This quote is ${quote.status}.`);
    if (order.status !== "quoted") return fail(409, "This order already has an accepted quote.");
    const spec = order.spec_json ? (JSON.parse(order.spec_json) as OrderSpec) : EMPTY_SPEC;
    if ((await itemsKey(spec)) !== quote.items_key) {
      await supersedeQuote(env.DB, quote.id);
      try {
        await agent.pushEvent(`Quote #${quote.id} no longer matches the order's items; send a new quote.`);
      } catch (err) {
        console.error("could not tell the agent about the outdated quote", err);
      }
      return fail(409, "The order changed since this quote. The agent will send a new one.");
    }
    if (!isAddress(env.RECEIVING_ADDRESS)) return fail(503, "Payments are not open yet. Please try again later.");
    const now = new Date();
    // The earlier acceptance that created an existing request already passed these checks.
    if (!existing) {
      const rates = await ratesFor(env.DB, quote.currency, now);
      if (!rates) return fail(503, "Exchange rates are updating. Please try again in a few minutes.");
      const policy = loadPolicy(env as unknown as Record<string, unknown>);
      if (Date.parse(quote.valid_until) <= now.getTime() || !quoteStillValid({ issuedAt: new Date(quote.issued_at), plnPerUnit: quote.pln_per_unit }, now, rates.plnPerUnit, policy)) {
        await expireQuote(env.DB, quote.id);
        try {
          await agent.pushEvent(`Quote #${quote.id} expired before the host accepted it: its validity ended (at most ${policy.quoteValidityHours} hours, less when the deadline is close) or the złoty moved more than the FX buffer. Send a new quote with send_quote.`);
        } catch (err) {
          console.error("could not tell the agent about the expired quote", err);
        }
        return fail(409, "This quote has expired. The agent will send a new one shortly.");
      }
    }
    const outcome = await acceptQuoteForOrder(env.DB, quote.id, order, now);
    if (outcome === "not_open") return fail(409, "This quote is no longer open.");
    if (outcome === "order_changed") return fail(409, "The order changed while you were accepting. Please reload the page and try again.");
    let payment: PaymentRequestRow;
    try {
      // The deposit is due within 48 hours, at most a day after the quote's validity, and never after the delivery deadline.
      const dueBy = new Date(Math.min(now.getTime() + 48 * 3_600_000, Date.parse(quote.valid_until) + 24 * 3_600_000, Date.parse(order.deliver_by)));
      // Reuses the request an earlier, half-finished acceptance of this quote created.
      payment = await createPaymentRequest(env.DB, { orderId: order.id, quoteId: quote.id, stage: "deposit", token: TOKEN_FOR[quote.currency], cents: quote.deposit_cents, dueBy }, now);
    } catch (err) {
      try {
        await reopenQuote(env.DB, quote.id);
        await setOrderStatus(env.DB, order.id, ["deposit_pending"], "quoted");
      } catch (err2) {
        console.error("could not undo the acceptance", err2);
      }
      throw err;
    }
    try {
      const amount = `${formatUnits(payment.amount_units)} ${payment.token}`;
      await agent.pushEvent(
        `The host accepted quote #${quote.id}. Deposit request #${payment.id}: ${amount} on Arc. Payments arrive as events.`,
        `Quote #${quote.id} accepted. Deposit due: ${amount}.`,
      );
      await agent.remindLater(new Date(Date.parse(payment.due_by) - 12 * 3_600_000).toISOString(), { kind: "payment", id: payment.id });
    } catch (err) {
      console.error("acceptance committed but follow-up failed", err);
    }
    return json(201, { requestId: payment.id }, NO_STORE);
  }

  if (m[3] && request.method === "POST") {
    const body = (await readJson(request)) as { txHash?: unknown } | undefined;
    const txHash = typeof body?.txHash === "string" ? body.txHash.trim().toLowerCase() : "";
    if (!/^0x[0-9a-f]{64}$/.test(txHash)) return fail(400, "paste the transaction hash: 0x followed by 64 characters");
    const payment = await getPaymentRequest(env.DB, Number(m[3]));
    if (!payment || payment.order_id !== order.id) return fail(404, "payment request not found");
    if (payment.status !== "open") return fail(409, "This payment is already complete.");
    const claims = (await env.DB.prepare("SELECT COUNT(*) AS n FROM payment_claims WHERE request_id = ?").bind(payment.id).first<{ n: number }>())?.n ?? 0;
    if (claims >= 5) return fail(429, "Too many transaction hashes for this payment. The owner will check it.");
    if ((await addClaim(env.DB, payment.id, txHash)) === "taken") return fail(409, "That transaction is already linked to another payment.");
    return json(201, { ok: true });
  }

  if (sub === "/design" && request.method === "POST") {
    if (Number(request.headers.get("content-length") ?? 0) > MAX_DESIGN_BYTES) return fail(413, "a design can be up to 64 KB");
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > MAX_DESIGN_BYTES) return fail(413, "a design can be up to 64 KB");
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return fail(400, "body must be JSON");
    }
    const parsed = DesignSpecSchema.safeParse(body);
    if (!parsed.success) return fail(400, issueText(parsed.error));
    if (order.status !== "draft" && order.status !== "quoted") return fail(409, "A quote was already accepted; the design can't change now.");
    const view = await agent.getView();
    const problems = designProblems(parsed.data, view.artwork.map((a) => ({ fileId: a.fileId, role: a.role })));
    if (problems.length) return fail(400, problems.join("; "));
    await agent.setDesign(parsed.data);
    return json(201, { ok: true });
  }

  if (sub === "/received" && request.method === "POST") {
    if (order.status !== "balance_paid" || !(await setOrderStatus(env.DB, order.id, ["balance_paid"], "closed"))) {
      return fail(409, "The order can be marked received once it is fully paid.");
    }
    try {
      // The printer job's on-time score counts from here.
      await markJob(env.DB, order.id, "delivered");
    } catch (err) {
      console.error("could not mark the printer job delivered", err);
    }
    try {
      await agent.pushEvent("The host confirmed the swag arrived. The order is closed: thank the host briefly.", "Delivery confirmed. The order is closed.");
    } catch (err) {
      console.error("could not tell the agent the order closed", err);
    }
    try {
      await (await getAgentByName(env.TreasuryAgent, TREASURY_NAME)).notify(`Order ${order.id} closed. Decide its reserve sweep.`);
    } catch (err) {
      console.error("could not tell the treasury agent the order closed", err);
    }
    return json(201, { ok: true });
  }

  return fail(405, "method not allowed");
}
