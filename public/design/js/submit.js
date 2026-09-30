// Sending a finished design: create the order, upload its files, attach the design. Everything
// that touches the network or the page is passed in, so the retry and resume paths are tested.

export class SendError extends Error {
  constructor(message, url = null) {
    super(message);
    this.url = url;
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
