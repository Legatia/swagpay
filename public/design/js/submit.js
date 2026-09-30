// Sending a finished design: create the order, upload its files, attach the design. Everything
// that touches the network or the page is passed in, so the retry and resume paths are tested.

import { SPEC_MAX_BYTES, specSize } from "./spec.js";

export class SendError extends Error {
  constructor(message, url = null) {
    super(message);
    this.url = url;
    this.reset = false;
  }
}

export const REQUEST_MAX = 4000;

// Cut at a code unit boundary that doesn't split a surrogate pair.
function cut(text, max) {
  if (text.length <= max) return text;
  let end = max - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

export function requestText(summary) {
  return cut(`Designed in the Swagpay editor. ${summary}`.trim(), REQUEST_MAX);
}

const FIELD_KEYS = ["eventName", "eventDate", "deliverBy", "deliveryPlace", "contactName", "contactEmail"];

export function buildIntake(contact, summary) {
  const out = {};
  for (const k of FIELD_KEYS) out[k] = String(contact?.[k] ?? "").trim();
  out.request = requestText(summary);
  out.designPending = true;
  return out;
}

export function withFileIds(spec, uploaded, url = null) {
  const files = {};
  for (const [key, meta] of Object.entries(spec.files)) {
    const up = uploaded[key];
    if (!up?.fileId) throw new SendError(`The file "${key}" wasn't uploaded. Send again.`, url);
    files[key] = { role: meta.role, fileId: up.fileId };
  }
  return { ...spec, files };
}

const FIELDS = { eventName: "Event name", eventDate: "Event date", deliverBy: "Deliver by", deliveryPlace: "Delivery place", contactName: "Your name", contactEmail: "Email", request: "The order description" };
const FALLBACK = "Something went wrong. Please try again.";

export function plainError(message) {
  let m = String(message ?? "").trim();
  if (!m) return FALLBACK;
  const prefix = /^(\w+): /.exec(m);
  if (prefix && FIELDS[prefix[1]]) m = `${FIELDS[prefix[1]]}: ${m.slice(prefix[0].length)}`;
  m = m.replace(/\bdeliverBy\b/g, "the delivery time").replace(/\beventDate\b/g, "the event date");
  return m.charAt(0).toUpperCase() + m.slice(1);
}

export function progressText(p) {
  switch (p.stage) {
    case "prepare": return "Preparing your files…";
    case "check": return "Checking you're human. If a box appears above, tick it.";
    case "create": return "Creating your order…";
    case "upload": return `Uploading files (${Math.min(p.done + 1, p.total)} of ${p.total})…`;
    case "design": return "Attaching your design…";
    case "done": return "Done. Opening your order…";
    default: return "";
  }
}

export async function sha256(blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const ATTEMPTS = 3;
export const BACKOFF_MS = 500;

const OFFLINE = "Swagpay couldn't be reached. Check your connection and send again; your design is kept.";
const HUMAN = "The human check didn't pass. Tick the box above if it shows one, then send again.";
const FILES_FULL = "This order already has as many files as it can take. Continue on your order page and tell the agent what changed.";
const ACCEPTED = "A quote was already accepted, so the design can't change now. Continue on your order page.";
const TOO_LARGE = "This design is too large to send. Remove a text layer or two, then send again.";
const GONE = "That order no longer exists. Send again to start a new one.";
const NOT_ATTACHED = "Your design couldn't be attached. Send again, or continue on your order page and tell the agent.";

// Status 0 means the request never got an answer (offline, DNS, CORS, aborted).
async function call(fetchFn, url, init) {
  let res;
  try {
    res = await fetchFn(url, init);
  } catch {
    return { status: 0, data: null };
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not JSON */
  }
  return { status: res.status, data };
}

const retryable = (status) => status === 0 || status >= 500;

async function withRetry(deps, attempt) {
  let r;
  for (let i = 1; i <= ATTEMPTS; i++) {
    r = await attempt();
    if (!retryable(r.status)) return r;
    if (i < ATTEMPTS) await deps.sleep(BACKOFF_MS * 3 ** (i - 1));
  }
  return r;
}

async function createOrder(intake, deps) {
  let r;
  for (let i = 1; i <= ATTEMPTS; i++) {
    deps.onProgress({ stage: "check" });
    const turnstile = await deps.nextToken();
    deps.onProgress({ stage: "create" });
    r = await call(deps.fetch, "/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...intake, turnstile }) });
    if (r.status === 201 && r.data?.token) return r.data;
    if (r.status === 403) continue; // single-use token: the next loop gets a fresh one
    if (!retryable(r.status)) throw new SendError(plainError(r.data?.error));
    if (i < ATTEMPTS) await deps.sleep(BACKOFF_MS * 3 ** (i - 1));
  }
  throw new SendError(r.status === 403 ? HUMAN : OFFLINE);
}

// The order was deleted or the saved token is stale: the caller forgets it and starts over.
function gone() {
  const err = new SendError(GONE);
  err.reset = true;
  return err;
}

function failure(r, url) {
  if (retryable(r.status)) return new SendError(OFFLINE, url);
  return new SendError(plainError(r.data?.error), url);
}

export async function sendOrder({ spec, files, intake, pending, deps }) {
  let p = pending?.token ? { token: pending.token, url: pending.url || `/o/${pending.token}`, uploaded: { ...(pending.uploaded || {}) } } : null;
  if (!p) {
    const created = await createOrder(intake, deps);
    p = { token: created.token, url: created.url || `/o/${created.token}`, uploaded: {} };
    deps.savePending(p);
  }
  const base = `/api/o/${p.token}`;

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    deps.onProgress({ stage: "upload", done: i, total: files.length });
    const hash = await deps.hash(f.blob);
    if (p.uploaded[f.key]?.hash === hash) continue;
    const r = await withRetry(deps, () => {
      const form = new FormData();
      form.append("file", new File([f.blob], f.name, { type: f.blob.type }));
      form.append("role", f.role);
      return call(deps.fetch, `${base}/artwork`, { method: "POST", body: form });
    });
    if (r.status === 201 && r.data?.fileId) {
      p = { ...p, uploaded: { ...p.uploaded, [f.key]: { hash, fileId: r.data.fileId } } };
      deps.savePending(p);
      continue;
    }
    if (r.status === 404) throw gone();
    if (r.status === 400 && /up to 10 files/.test(r.data?.error ?? "")) throw new SendError(FILES_FULL, p.url);
    throw failure(r, p.url);
  }

  deps.onProgress({ stage: "design" });
  const design = withFileIds(spec, p.uploaded, p.url);
  if (specSize(design) > SPEC_MAX_BYTES) throw new SendError(TOO_LARGE, p.url);
  const r = await withRetry(deps, () => call(deps.fetch, `${base}/design`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(design) }));
  if (r.status === 201) return { url: p.url };
  if (r.status === 404) throw gone();
  if (r.status === 400) throw new SendError(NOT_ATTACHED, p.url); // the backend's schema message isn't host-readable
  if (r.status === 409) throw new SendError(ACCEPTED, p.url);
  if (r.status === 413) throw new SendError(TOO_LARGE, p.url);
  throw failure(r, p.url);
}
