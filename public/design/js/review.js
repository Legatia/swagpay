import { currentEstimate } from "./details.js";
import { buildFiles } from "./files.js";
import { buildSpec, summarize } from "./spec.js";
import { SendError, buildIntake, progressText, sendOrder, sha256 } from "./submit.js";
import { mountTurnstile, nextToken } from "./turnstile.js";

const $ = (id) => document.getElementById(id);
let sending = false;
let mounted = false;
let storeRef = null;

function mount() {
  if (mounted) return;
  mounted = true;
  mountTurnstile($("turnstile")).catch(() => {
    mounted = false; // try again on the next render, e.g. after coming back online
    $("send-error").textContent = "The human check could not load. Check your connection; it retries when you're back online.";
  });
}

export function renderReview(s) {
  mount();
  const { spec, error } = buildSpec({ ...s, estimate: currentEstimate(s) });
  $("summary").textContent = error ?? summarize(spec);
  $("resume-note").hidden = !s.send?.token || sending;
  $("new-order").hidden = !s.send?.token || sending;
  const offline = navigator.onLine === false;
  $("offline").hidden = !offline;
  const send = $("send");
  send.disabled = sending || offline || Boolean(error);
  send.textContent = s.send?.token ? "Finish sending" : "Send to the agent";
}

async function send() {
  if (sending) return;
  const form = $("contact-form");
  if (!form.reportValidity()) return;
  const store = storeRef;
  const s = store.get();
  const { spec, error } = buildSpec({ ...s, estimate: currentEstimate(s) });
  if (error) {
    $("send-error").textContent = error;
    return;
  }
  sending = true;
  $("send").disabled = true;
  $("send-error").textContent = "";
  $("order-link").hidden = true;
  $("send-status").hidden = false;
  const show = (p) => ($("send-step").textContent = progressText(p));
  try {
    show({ stage: "prepare" });
    const files = await buildFiles(s, spec);
    const { url } = await sendOrder({
      spec,
      files,
      intake: buildIntake(s.contact, summarize(spec)),
      pending: s.send,
      deps: {
        fetch: (...args) => fetch(...args),
        nextToken,
        hash: sha256,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        onProgress: show,
        savePending: (p) => store.set({ send: p }, { record: false }),
      },
    });
    show({ stage: "done" });
    store.finish();
    // replace, not assign: Back from the order page must not restore this editor from the bfcache.
    location.replace(url);
  } catch (err) {
    sending = false;
    $("send-status").hidden = true;
    if (err?.reset) store.set({ send: null }, { record: false });
    $("send-error").textContent = err instanceof SendError ? err.message : "Something went wrong while sending. Send again; your design is kept.";
    if (err?.url) {
      const a = $("order-link");
      a.href = err.url;
      a.hidden = false;
    }
    renderReview(store.get());
    // The button was disabled while sending, which dropped keyboard focus to the page. Put it back
    // so the person can fix the form and press Send again.
    if (!$("send").disabled) $("send").focus();
    // The fixed bottom bar covers the lower edge of the form on a phone; scroll-margin on these two
    // keeps the message clear of it.
    ($("order-link").hidden ? $("send-error") : $("order-link")).scrollIntoView({ block: "nearest" });
  }
}

export function initReview({ store }) {
  storeRef = store;
  const form = $("contact-form");
  const contact = store.get().contact || {};
  for (const el of form.elements) if (el.name && contact[el.name] != null) el.value = contact[el.name];
  form.addEventListener("input", (e) => {
    const { name, value } = e.target;
    if (!name) return;
    store.set((st) => ({ ...st, contact: { ...st.contact, [name]: value } }), { record: false });
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    send();
  });
  const refresh = () => {
    if (store.get().step === "review") renderReview(store.get());
  };
  // The one way out of a pending order. The host has to choose it, so a second order is never an accident.
  $("new-order").addEventListener("click", () => {
    if (sending) return;
    store.set({ send: null }, { record: false });
    $("send-error").textContent = "";
    $("order-link").hidden = true;
    renderReview(store.get());
  });
  window.addEventListener("online", refresh);
  window.addEventListener("offline", refresh);
}
