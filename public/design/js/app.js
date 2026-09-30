import { renderControls, updateCutPath } from "./controls.js";
import { currentEstimate, initPricing, renderDetails, resetDetails } from "./details.js";
import { clampToArea } from "./geometry.js";
import { attachGestures } from "./gestures.js";
import { newImageLayer, newTextLayer, nextAssetKey } from "./layers.js";
import { mockupFor } from "./mockups.js";
import { renderPanel } from "./panel.js";
import { formatEstimate } from "./pricing.js";
import { OWNER_NOTE, PRODUCTS, defaultOptions, viewAreas } from "./products.js";
import { registerServiceWorker, showInstallHint } from "./pwa.js";
import { layerQuality, qualityMessage } from "./quality.js";
import { initReview, renderReview } from "./review.js";
import { buildSpec } from "./spec.js";
import { measureText, renderStage } from "./stage.js";
import { createStore, loadDraft } from "./store.js";
import { readAsset } from "./upload.js";

const $ = (id) => document.getElementById(id);
const app = $("design-app");
const svg = $("stage");
const STEPS = ["product", "design", "details", "review"];

// Private or restricted browser modes either throw when storage is touched or refuse writes. The
// editor works either way; `writable` tells us whether to say drafts can't be saved.
function probeStorage() {
  let storage = null;
  try {
    storage = window.localStorage;
  } catch {
    return { storage: null, writable: false };
  }
  try {
    storage.setItem("swagpay-design-probe", "1");
    storage.removeItem("swagpay-design-probe");
    return { storage, writable: true };
  } catch {
    return { storage, writable: false };
  }
}

const initial = {
  step: "product",
  product: null,
  options: {},
  sticker: { longestSideMm: 75, shape: "contour" },
  side: "front",
  areas: [],
  layers: { front: [], back: [] },
  assets: {},
  selectedId: null,
  sizes: {},
  quantity: 1,
  currency: "USD",
  cutPathD: null,
  contact: { eventName: "", eventDate: "", deliverBy: "", deliveryPlace: "Kolektyw3, Koszykowa 54, Warsaw", contactName: "", contactEmail: "" },
  send: null,
};

// A draft saved while storage was full keeps its layers but not its images (the store saves
// `assets: {}`). Drop image layers whose file is missing so the stage never draws a broken image.
function dropUnsavedImages(draft) {
  if (!draft) return { draft, dropped: false };
  const assets = draft.assets && typeof draft.assets === "object" ? draft.assets : {};
  const dropIds = new Set();
  const layers = { ...draft.layers };
  for (const side of Object.keys(layers)) {
    if (!Array.isArray(layers[side])) continue;
    layers[side] = layers[side].filter((l) => {
      const missing = l?.type === "image" && !assets[l.file];
      if (missing) dropIds.add(l.id);
      return !missing;
    });
  }
  if (!dropIds.size) return { draft, dropped: false };
  const selectedId = dropIds.has(draft.selectedId) ? null : draft.selectedId;
  // The cut line was traced from the dropped logo, and the host adds the logo again anyway.
  return { draft: { ...draft, layers, assets, selectedId, cutPathD: null, ...(draft.product ? { step: "design" } : {}) }, dropped: true };
}

const { storage, writable: storageWritable } = probeStorage();
const loaded = dropUnsavedImages(loadDraft(storage));
const draft = loaded.draft;
export const store = createStore({ initial: draft ? { ...initial, ...draft } : initial, storage, keep: ["step", "sizes", "quantity", "currency", "contact", "send"] });

export function area() {
  const s = store.get();
  return s.areas.find((a) => a.side === s.side) ?? s.areas[0];
}

export function ctx() {
  const s = store.get();
  const p = PRODUCTS[s.product];
  const a = area();
  return {
    product: s.product,
    side: s.side,
    area: a,
    mockup: mockupFor(s.product, s.side, a),
    layers: s.layers[s.side] || [],
    assets: s.assets,
    selectedId: s.selectedId,
    colourHex: p?.colours?.find((c) => c.key === s.options.colour)?.hex ?? "#ffffff",
    cutPathD: s.product === "sticker" ? s.cutPathD : null,
    borderMm: p?.borderMm ?? 0,
  };
}

export function announce(text) {
  $("live").textContent = text;
}

let noticeTimer;
export function notice(text) {
  $("notice").textContent = text;
  clearTimeout(noticeTimer);
  if (text) noticeTimer = setTimeout(() => ($("notice").textContent = ""), 6000);
}

function renderProducts() {
  const list = $("products");
  list.replaceChildren(
    ...Object.values(PRODUCTS).map((p) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "product";
      b.dataset.product = p.key;
      b.innerHTML = `<b></b><small></small>${p.needsOwner ? '<span class="owner"></span>' : ""}`;
      b.querySelector("b").textContent = p.name;
      b.querySelector("small").textContent = p.blurb;
      if (p.needsOwner) b.querySelector(".owner").textContent = OWNER_NOTE;
      return b;
    }),
  );
}

export function pickProduct(key) {
  resetDetails();
  const s = store.get();
  const options = s.product === key ? s.options : defaultOptions(key);
  const areas = viewAreas(key, options, s.sticker);
  const keep = s.product === key;
  store.set(
    {
      product: key,
      options,
      areas,
      side: areas[0].side,
      layers: keep ? s.layers : { front: [], back: [] },
      selectedId: null,
      cutPathD: keep ? s.cutPathD : null,
      step: "design",
    },
    { record: s.product !== null && s.product !== key },
  );
}

async function addLogo(file) {
  try {
    const asset = await readAsset(file);
    const s = store.get();
    const key = nextAssetKey(s.assets);
    const layer = clampToArea(newImageLayer(key, asset, area()), area()).layer;
    store.set({ assets: { ...s.assets, [key]: asset }, layers: { ...s.layers, [s.side]: [...s.layers[s.side], layer] }, selectedId: layer.id });
    if (store.saveProblem() === "assets") notice("Your logo isn't saved on this device (storage is full). Keep this tab open until you're done.");
    announce(`${asset.name} added.`);
  } catch (err) {
    notice(err.message);
  }
}

export function qualityIssues() {
  const s = store.get();
  const p = PRODUCTS[s.product];
  if (!p) return [];
  const issues = [];
  for (const side of Object.keys(s.layers)) {
    for (const l of s.layers[side]) {
      const q = layerQuality(l, s.assets[l.file], p.dpi);
      const message = qualityMessage(q, s.assets[l.file]?.name ?? "This image");
      if (message) issues.push({ status: q.status, message });
    }
  }
  return issues;
}

function renderQuality() {
  const list = $("quality");
  list.replaceChildren(
    ...qualityIssues().map((i) => {
      const li = document.createElement("li");
      li.dataset.status = i.status;
      li.textContent = i.message;
      return li;
    }),
  );
}

function syncTextWidths() {
  const widths = measureText(svg);
  const s = store.get();
  let changed = false;
  const list = (s.layers[s.side] || []).map((l) => {
    const w = widths[l.id];
    if (l.type !== "text" || !w || Math.abs(w - l.widthMm) < 0.5) return l;
    changed = true;
    const cx = l.xMm + l.widthMm / 2;
    const measured = { ...l, widthMm: w, xMm: l.align === "center" ? cx - w / 2 : l.align === "right" ? l.xMm + l.widthMm - w : l.xMm };
    // A long line can measure wider than the print area: shrink it to fit, like any other layer.
    return clampToArea(measured, area()).layer;
  });
  if (changed) store.set({ layers: { ...s.layers, [s.side]: list } }, { record: false });
}

export const renderers = [];

// The button that was just pressed is hidden by the step change, so keyboard focus would fall to
// the page. Move it to the new step's heading instead.
let shownStep = null;
function focusStepHeading(step) {
  const h = $(`step-${step}`).querySelector("h1");
  if (!h) return;
  h.tabIndex = -1;
  h.focus({ preventScroll: true });
}

function render() {
  const s = store.get();
  const stepChanged = shownStep !== null && shownStep !== s.step;
  shownStep = s.step;
  app.dataset.step = s.step;
  for (const step of STEPS) $(`step-${step}`).hidden = step !== s.step;
  $("back").disabled = s.step === "product";
  $("next").hidden = s.step === "product" || s.step === "review";
  $("undo").disabled = !store.canUndo();
  $("redo").disabled = !store.canRedo();
  if (s.step === "design" && s.product) {
    $("stage-empty").hidden = (s.layers[s.side] || []).length > 0;
    renderStage(svg, ctx());
    renderQuality();
    requestAnimationFrame(syncTextWidths);
  }
  for (const fn of renderers) fn(s);
  if (stepChanged) focusStepHeading(s.step);
}

function go(step) {
  store.set({ step, selectedId: null }, { record: false });
  window.scrollTo({ top: 0 });
}

export const beforeNext = {
  design: () => {
    const s = store.get();
    if (!Object.values(s.layers).some((list) => list.length)) return "Add a logo or some text first.";
    if (Object.values(s.layers).some((list) => list.length > 20)) return "A side can have at most 20 layers.";
    if (qualityIssues().some((i) => i.status === "block")) return "Fix the resolution problem first.";
    return null;
  },
};

function addText() {
  const s = store.get();
  const dark = ["black", "navy"].includes(s.options.colour);
  const layer = clampToArea(newTextLayer(area(), { colour: dark ? "#ffffff" : "#171a38" }), area()).layer;
  store.set({ layers: { ...s.layers, [s.side]: [...s.layers[s.side], layer] }, selectedId: layer.id });
  announce("Text added. Edit it in the panel.");
  requestAnimationFrame(() => document.querySelector('#panel [data-k="text"]')?.select());
}

function init() {
  attachGestures({ svg, store, getContext: ctx, announce, notice });
  initReview({ store });
  renderProducts();
  $("products").addEventListener("click", (e) => {
    const b = e.target.closest("[data-product]");
    if (b) pickProduct(b.dataset.product);
  });
  $("logo-file").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) addLogo(file);
    e.target.value = "";
  });
  $("add-text").addEventListener("click", addText);
  renderers.push((s) => {
    if (s.step !== "design" || !s.product) return;
    renderPanel($("panel"), s, { store, area, announce });
    renderControls($("product-controls"), s, { store });
  });
  renderers.push((s) => {
    if (s.step === "details") renderDetails($("details"), s, { store });
    if (s.step === "review") renderReview(s);
    $("estimate-bar").textContent = s.product && s.step !== "product" ? formatEstimate(currentEstimate(s)) : "";
  });
  beforeNext.details = () => {
    const s = store.get();
    const { error } = buildSpec({ ...s, estimate: currentEstimate(s) });
    // A restored draft may have no cut line yet; start it so the next try works.
    if (error && s.product === "sticker" && !s.cutPathD) updateCutPath(store);
    return error ?? null;
  };
  initPricing().then(() => store.set({}, { record: false, persist: false }));
  store.subscribe((s) => {
    if (s.product === "sticker" && s.step === "design") updateCutPath(store);
  });
  $("undo").addEventListener("click", () => store.undo());
  $("redo").addEventListener("click", () => store.redo());
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z" || e.target.closest?.("input, textarea, select")) return;
    if (store.get().step !== "design") return;
    e.preventDefault();
    if (e.shiftKey) store.redo();
    else store.undo();
  });
  $("back").addEventListener("click", () => go(STEPS[Math.max(0, STEPS.indexOf(store.get().step) - 1)]));
  $("next").addEventListener("click", () => {
    const s = store.get();
    const problem = beforeNext[s.step]?.();
    if (problem) return notice(problem);
    go(STEPS[Math.min(STEPS.length - 1, STEPS.indexOf(s.step) + 1)]);
  });
  if (!storageWritable || store.saveProblem() === "all") notice("Drafts can't be saved in this browser mode. Your design stays while this tab is open.");
  if (loaded.dropped) notice("Your logo wasn't saved on this device, so it was removed. Add it again.");
  store.subscribe(render);
  render();
  showInstallHint($("install-hint"));
  registerServiceWorker();
}

init();
// A page restored from the back-forward cache keeps stale state (sending stuck, a store that no
// longer saves), so start over from the saved draft. Only when the draft is fully on disk: if it
// isn't, keep the restored page, which still holds the design.
window.addEventListener("pageshow", (e) => {
  if (e.persisted && storageWritable && store.saveProblem() === null) location.reload();
});
