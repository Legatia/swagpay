import { clampToArea, pinchTransform } from "./geometry.js";
import { findLayer, removeLayer, replaceLayer, transformLayer } from "./layers.js";
import { svgPoint } from "./stage.js";

// Touch: drag moves, pinch resizes, twist rotates. Mouse: drag, plus the resize and rotate handles.
// Keyboard: arrows move (Shift ×10), + / - resize, [ / ] rotate, Delete removes, Escape deselects.
export function attachGestures({ svg, store, getContext, announce }) {
  const pointers = new Map();
  let gesture = null;

  const local = (e) => {
    const p = svgPoint(svg, e.clientX, e.clientY);
    const { mockup } = getContext();
    return { x: p.x - mockup.origin.x, y: p.y - mockup.origin.y };
  };
  const current = () => {
    const s = store.get();
    return gesture ? findLayer(s, s.side, gesture.id) : null;
  };
  const put = (layer, opts) => store.set((s) => replaceLayer(s, s.side, layer), opts);
  const centre = (l) => ({ x: l.xMm + l.widthMm / 2, y: l.yMm + l.heightMm / 2 });

  // One undo step per gesture, taken just before the first change so a plain tap adds none.
  function checkpointOnce() {
    if (gesture && !gesture.checkpointed) {
      store.checkpoint();
      gesture.checkpointed = true;
    }
  }

  function finish() {
    const layer = current();
    if (layer) {
      const { layer: inside, clamped } = clampToArea(layer, getContext().area);
      if (clamped) checkpointOnce();
      put(inside, { record: false, persist: true });
      if (clamped) announce("Moved back inside the print area.");
    }
    gesture = null;
  }

  svg.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const p = local(e);
    pointers.set(e.pointerId, p);
    svg.setPointerCapture(e.pointerId);
    const s = store.get();
    if (pointers.size === 2 && s.selectedId) {
      const [a0, b0] = [...pointers.values()];
      gesture = { kind: "pinch", id: s.selectedId, start: findLayer(s, s.side, s.selectedId), a0, b0, checkpointed: gesture?.checkpointed ?? false };
      return;
    }
    if (pointers.size !== 1) return;
    const handle = e.target.closest("[data-handle]");
    const layerEl = e.target.closest("[data-layer]");
    if (handle && s.selectedId) {
      const start = findLayer(s, s.side, s.selectedId);
      gesture = { kind: handle.dataset.handle, id: s.selectedId, start, p0: p, c: centre(start), checkpointed: false };
    } else if (layerEl) {
      const id = layerEl.dataset.layer;
      if (s.selectedId !== id) store.set({ selectedId: id }, { record: false, persist: false });
      gesture = { kind: "move", id, start: findLayer(store.get(), s.side, id), p0: p, checkpointed: false };
    } else {
      if (s.selectedId) store.set({ selectedId: null }, { record: false, persist: false });
      gesture = null;
      return;
    }
    e.preventDefault();
  });

  svg.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId) || !gesture) return;
    const p = local(e);
    pointers.set(e.pointerId, p);
    const g = gesture;
    let next;
    if (g.kind === "move") next = transformLayer(g.start, { dx: p.x - g.p0.x, dy: p.y - g.p0.y });
    else if (g.kind === "resize") next = transformLayer(g.start, { scale: Math.hypot(p.x - g.c.x, p.y - g.c.y) / Math.max(1e-6, Math.hypot(g.p0.x - g.c.x, g.p0.y - g.c.y)) });
    else if (g.kind === "rotate") next = transformLayer(g.start, { rotationDeg: ((Math.atan2(p.y - g.c.y, p.x - g.c.x) - Math.atan2(g.p0.y - g.c.y, g.p0.x - g.c.x)) * 180) / Math.PI });
    else if (g.kind === "pinch" && pointers.size >= 2) {
      const [a1, b1] = [...pointers.values()];
      next = transformLayer(g.start, pinchTransform(g.a0, g.b0, a1, b1));
    }
    if (next) {
      checkpointOnce();
      put(next, { record: false, persist: false });
    }
    e.preventDefault();
  });

  const end = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
    if (!gesture) return;
    if (pointers.size === 1 && gesture.kind === "pinch") {
      const [p] = [...pointers.values()];
      gesture = { kind: "move", id: gesture.id, start: current(), p0: p, checkpointed: gesture.checkpointed };
    } else if (pointers.size === 0) {
      finish();
    }
  };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);

  svg.addEventListener("keydown", (e) => {
    const s = store.get();
    const layer = s.selectedId ? findLayer(s, s.side, s.selectedId) : null;
    if (!layer) return;
    const step = e.shiftKey ? 10 : 1;
    const moves = { ArrowLeft: { dx: -step }, ArrowRight: { dx: step }, ArrowUp: { dy: -step }, ArrowDown: { dy: step }, "+": { scale: 1.05 }, "=": { scale: 1.05 }, "-": { scale: 0.95 }, "[": { rotationDeg: -5 }, "]": { rotationDeg: 5 } };
    if (e.key === "Delete" || e.key === "Backspace") {
      store.set((st) => removeLayer(st, st.side, layer.id));
      announce("Layer removed.");
    } else if (e.key === "Escape") {
      store.set({ selectedId: null }, { record: false, persist: false });
    } else if (moves[e.key]) {
      const { layer: inside, clamped } = clampToArea(transformLayer(layer, moves[e.key]), getContext().area);
      put(inside);
      announce(clamped ? "At the edge of the print area." : `${Math.round(inside.xMm / 10)} cm from the left, ${Math.round(inside.yMm / 10)} cm from the top, ${Math.round(inside.widthMm / 10)} cm wide.`);
    } else {
      return;
    }
    e.preventDefault();
  });
}
