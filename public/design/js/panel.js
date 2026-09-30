import { clampToArea, normalizeDeg } from "./geometry.js";
import { findLayer, removeLayer, replaceLayer } from "./layers.js";

const FONTS = ["Figtree", "Big Shoulders Display", "IBM Plex Mono"];
let shownId = null;

function field(label, input) {
  const wrap = document.createElement("label");
  wrap.textContent = label;
  wrap.append(input);
  return wrap;
}

function input(type, attrs) {
  const i = document.createElement(type === "select" ? "select" : "input");
  if (type !== "select") i.type = type;
  for (const [k, v] of Object.entries(attrs)) i.setAttribute(k, v);
  return i;
}

function syncFields(container, layer, force) {
  const values = { x: (layer.xMm / 10).toFixed(1), y: (layer.yMm / 10).toFixed(1), w: (layer.widthMm / 10).toFixed(1), r: Math.round(layer.rotationDeg), text: layer.text, font: layer.font, colour: layer.colour, align: layer.align };
  for (const el of container.querySelectorAll("[data-k]")) {
    if ((force || el !== document.activeElement) && values[el.dataset.k] != null) el.value = values[el.dataset.k];
  }
}

// Rebuilds only when the selected layer changes, so typing never loses focus; otherwise it refreshes
// the values of fields that aren't being edited.
export function renderPanel(container, state, { store, area, announce }) {
  const layer = state.selectedId ? findLayer(state, state.side, state.selectedId) : null;
  if (!layer) {
    shownId = null;
    container.replaceChildren();
    return;
  }
  const commit = (patch, opts) => {
    const s = store.get();
    const current = findLayer(s, s.side, layer.id);
    if (!current) return;
    const { layer: inside } = clampToArea({ ...current, ...patch }, area());
    store.set((st) => replaceLayer(st, st.side, inside), opts);
  };
  // A typed number the editor changed (720 -> 0, 50 cm -> the area width) shows the real value even
  // while the field still has focus.
  const commitNumber = (patch) => {
    commit(patch);
    const now = findLayer(store.get(), store.get().side, layer.id);
    if (now) syncFields(container, now, true);
  };
  if (shownId !== layer.id) {
    shownId = layer.id;
    const x = input("number", { step: "0.1", "data-k": "x" });
    const y = input("number", { step: "0.1", "data-k": "y" });
    const w = input("number", { step: "0.1", min: "0.5", "data-k": "w" });
    const r = input("number", { step: "1", "data-k": "r" });
    // An emptied or invalid field goes back to the layer's real value instead of jumping to 0.
    const resync = () => {
      const s = store.get();
      const cur = findLayer(s, s.side, layer.id);
      if (cur) syncFields(container, cur, true);
    };
    const typed = (el) => (el.value.trim() !== "" && Number.isFinite(Number(el.value)) ? Number(el.value) * 10 : null);
    x.addEventListener("change", () => (typed(x) === null ? resync() : commitNumber({ xMm: typed(x) })));
    y.addEventListener("change", () => (typed(y) === null ? resync() : commitNumber({ yMm: typed(y) })));
    w.addEventListener("change", () => {
      const s = store.get();
      const cur = findLayer(s, s.side, layer.id);
      const wanted = typed(w);
      if (wanted === null || !(wanted > 0)) return syncFields(container, cur, true);
      // Same 5 mm floor as the keyboard resize, so the spec never carries a sliver.
      const k = Math.max(wanted / cur.widthMm, 5 / cur.widthMm);
      commitNumber({ widthMm: cur.widthMm * k, heightMm: cur.heightMm * k, ...(cur.type === "text" ? { sizeMm: cur.sizeMm * k } : {}) });
    });
    r.addEventListener("change", () => commitNumber({ rotationDeg: normalizeDeg(Number(r.value) || 0) }));
    const rows = [field("From left (cm)", x), field("From top (cm)", y), field("Width (cm)", w), field("Rotation (°)", r)];
    const grid = document.createElement("div");
    grid.className = "grid2";
    grid.append(...rows);
    const parts = [grid];
    if (layer.type === "text") {
      const text = input("text", { maxlength: "200", "data-k": "text" });
      // One undo step per edit: snapshot before the first keystroke, then commit without recording.
      let editing = false;
      text.addEventListener("input", () => {
        if (!editing) {
          editing = true;
          store.checkpoint();
        }
        commit({ text: text.value || " " }, { record: false, persist: false });
      });
      text.addEventListener("change", () => {
        editing = false;
        commit({ text: text.value.trim() || "Your text" }, { record: false });
      });
      const font = input("select", { "data-k": "font" });
      for (const f of FONTS) font.add(new Option(f, f));
      font.addEventListener("change", () => commit({ font: font.value, weight: font.value === "Big Shoulders Display" ? 800 : 700 }));
      const colour = input("color", { "data-k": "colour" });
      colour.addEventListener("change", () => commit({ colour: colour.value }));
      const align = input("select", { "data-k": "align" });
      for (const [v, l] of [["left", "Left"], ["center", "Centre"], ["right", "Right"]]) align.add(new Option(l, v));
      align.addEventListener("change", () => commit({ align: align.value }));
      const g2 = document.createElement("div");
      g2.className = "grid2";
      g2.append(field("Font", font), field("Colour", colour), field("Align", align));
      parts.unshift(field("Text", text));
      parts.push(g2);
    }
    const del = document.createElement("button");
    del.type = "button";
    del.className = "secondary danger";
    del.textContent = layer.type === "text" ? "Remove text" : "Remove logo";
    del.addEventListener("click", () => {
      store.set((st) => removeLayer(st, st.side, layer.id));
      announce("Layer removed.");
      // The panel empties, so keyboard focus goes to the stage instead of the page top.
      document.getElementById("stage")?.focus({ preventScroll: true });
    });
    parts.push(del);
    const title = document.createElement("h2");
    title.className = "card-title";
    title.textContent = layer.type === "text" ? "Text" : "Logo";
    container.replaceChildren(title, ...parts);
  }
  syncFields(container, layer, false);
}
