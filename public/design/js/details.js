import { PRODUCTS, SIZE_KEYS } from "./products.js";
import { capNotice, estimate, formatEstimate, loadPricing, totalSizes } from "./pricing.js";

let pricing = null;
let table = null;
let shownFor = null;

export async function initPricing() {
  const [p, t] = await Promise.all([
    loadPricing(),
    fetch("/design/price-table.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  pricing = p;
  table = t;
}

export function currentEstimate(s) {
  if (!s.product) return { status: "empty" };
  const printedSides = Object.keys(s.layers).filter((side) => s.layers[side].length);
  return estimate({ product: s.product, options: s.options, sticker: s.sticker, sizes: s.sizes, quantity: s.quantity, printedSides, currency: s.currency }, table, pricing);
}

function numberField(label, value, onInput) {
  const wrap = document.createElement("label");
  wrap.textContent = label;
  const i = document.createElement("input");
  i.type = "number";
  i.min = "0";
  i.max = "5000";
  i.step = "1";
  i.inputMode = "numeric";
  i.value = value || "";
  i.addEventListener("input", () => onInput(i.value));
  wrap.append(i);
  return wrap;
}

// Built once per product; inputs keep focus while the estimate bar updates.
export function renderDetails(container, s, { store }) {
  const key = `${s.product}`;
  if (shownFor !== key) {
    shownFor = key;
    const parts = [];
    if (s.product === "tshirt") {
      const sizes = document.createElement("div");
      sizes.className = "sizes";
      for (const k of SIZE_KEYS) sizes.append(numberField(k, s.sizes[k], (v) => store.set((st) => ({ ...st, sizes: { ...st.sizes, [k]: v } }), { record: false })));
      parts.push(sizes);
      const total = document.createElement("p");
      total.id = "size-total";
      total.className = "muted";
      parts.push(total);
    } else {
      parts.push(numberField(s.product === "sticker" ? "How many stickers?" : "How many?", s.quantity, (v) => store.set({ quantity: v }, { record: false })));
    }
    const cur = document.createElement("label");
    cur.textContent = "Show prices in";
    const sel = document.createElement("select");
    sel.add(new Option("US dollars (USDC)", "USD"));
    sel.add(new Option("Euros (EURC)", "EUR"));
    sel.value = s.currency;
    sel.addEventListener("change", () => store.set({ currency: sel.value }, { record: false }));
    cur.append(sel);
    parts.push(cur);
    const est = document.createElement("p");
    est.id = "estimate";
    parts.push(est);
    if (PRODUCTS[s.product].needsOwner) {
      const note = document.createElement("p");
      note.className = "muted";
      note.textContent = "The owner confirms large-format orders before the agent quotes them.";
      parts.push(note);
    }
    container.replaceChildren(...parts);
  }
  const total = container.querySelector("#size-total");
  if (total) total.textContent = `Total: ${totalSizes(s.sizes)} t-shirts`;
  const result = currentEstimate(s);
  const text = formatEstimate(result);
  const cap = capNotice(result, pricing);
  const est = container.querySelector("#estimate");
  if (est) est.textContent = text ? `${text}. The agent confirms the price after checking with printers.${cap ? ` ${cap}` : ""}` : "";
}

export function resetDetails() {
  shownFor = null;
}
