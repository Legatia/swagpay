import { PRODUCTS, cm, viewAreas } from "./products.js";
import { rasterize } from "./raster.js";
import { allowedShapes, circlePathD, roundedSquarePathD, simplify, smoothPathD, traceOutline } from "./sticker.js";

function chip(key, label, pressed, onClick, extra) {
  const b = document.createElement("button");
  b.dataset.key = key;
  b.type = "button";
  b.className = "chip";
  b.setAttribute("aria-pressed", String(pressed));
  if (extra) b.append(extra);
  b.append(label);
  b.addEventListener("click", onClick);
  return b;
}

function group(title, chips) {
  const wrap = document.createElement("div");
  const h = document.createElement("p");
  h.className = "muted";
  h.textContent = title;
  const row = document.createElement("div");
  row.className = "chips";
  row.append(...chips);
  wrap.append(h, row);
  return wrap;
}

const PX_PER_MM = 8;
let cutTimer;
let cutTicket = 0;

// Sticker cut line: rasterize the artwork at 8 px/mm with room for the border, trace, and convert to
// whole-sticker millimetres. Circle and rounded square are exact shapes.
export function updateCutPath(store) {
  clearTimeout(cutTimer);
  // A newer request, or leaving the sticker, makes a slow trace stale: it must not land.
  const ticket = ++cutTicket;
  cutTimer = setTimeout(async () => {
    const s = store.get();
    if (s.product !== "sticker") return;
    const p = PRODUCTS.sticker;
    const L = s.sticker.longestSideMm;
    const layers = s.layers.front || [];
    const shapes = allowedShapes(layers, s.assets);
    let shape = shapes.includes(s.sticker.shape) ? s.sticker.shape : "rounded-square";
    let d = null;
    if (!layers.length) d = null;
    else if (shape === "circle") d = circlePathD(L);
    else if (shape === "rounded-square") d = roundedSquarePathD(L);
    else {
      try {
        const borderPx = p.borderMm * PX_PER_MM;
        const pad = borderPx + 4;
        const canvas = await rasterize({ area: s.areas[0], layers, assets: s.assets, pxPerMm: PX_PER_MM, padPx: pad });
        const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        const alpha = new Uint8ClampedArray(canvas.width * canvas.height);
        for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];
        const pts = traceOutline(alpha, canvas.width, canvas.height, { dilatePx: borderPx });
        d = pts ? smoothPathD(simplify(pts, 1), { scale: PX_PER_MM, offsetX: pad - borderPx, offsetY: pad - borderPx }) : null;
      } catch {
        d = null;
      }
      // No usable trace: cut a rounded square, and say so in the shape the spec carries.
      if (!d) {
        shape = "rounded-square";
        d = roundedSquarePathD(L);
      }
    }
    if (ticket !== cutTicket) return;
    const now = store.get();
    if (now.product !== "sticker") return;
    if (now.cutPathD !== d || now.sticker.shape !== shape) store.set({ cutPathD: d, sticker: { ...now.sticker, shape } }, { record: false });
  }, 250);
}

// Every store change rebuilds the chips, so remember which one has focus and put it back.
export function renderControls(container, s, { store }) {
  const active = document.activeElement;
  const focusKey = active && container.contains(active) ? active.dataset.key : null;
  buildControls(container, s, { store });
  if (focusKey) container.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
}

function buildControls(container, s, { store }) {
  const p = PRODUCTS[s.product];
  if (!p) return container.replaceChildren();
  const parts = [];
  if (p.views && p.views.length > 1) {
    parts.push(group("Side", p.views.map((v) => chip(`side:${v.side}`, v.side === "front" ? "Front" : "Back", s.side === v.side, () => store.set({ side: v.side, selectedId: null }, { record: false })))));
  }
  if (p.colours) {
    parts.push(group("Colour", p.colours.map((c) => {
      const dot = document.createElement("span");
      dot.className = "swatch";
      dot.style.background = c.hex;
      return chip(`colour:${c.key}`, c.label, s.options.colour === c.key, () => store.set({ options: { ...s.options, colour: c.key } }), dot);
    })));
  }
  if (p.presets && p.presets.length > 1) {
    parts.push(group("Size", p.presets.map((x) => chip(`preset:${x.key}`, x.label, s.options.size === x.key, () => {
      const options = { ...s.options, size: x.key };
      store.set({ options, areas: viewAreas(s.product, options, s.sticker), layers: { front: [], back: [] }, selectedId: null });
    }))));
  }
  if (p.sizes) {
    parts.push(group("Size (longest side)", p.sizes.map((L) => chip(`size:${L}`, cm(L), s.sticker.longestSideMm === L, () => {
      const sticker = { ...s.sticker, longestSideMm: L };
      const oldA = s.areas[0].widthMm;
      const newA = viewAreas("sticker", {}, sticker)[0];
      const k = newA.widthMm / oldA;
      const scaled = (s.layers.front || []).map((l) => ({ ...l, xMm: l.xMm * k, yMm: l.yMm * k, widthMm: l.widthMm * k, heightMm: l.heightMm * k, ...(l.type === "text" ? { sizeMm: l.sizeMm * k } : {}) }));
      store.set({ sticker, areas: [newA], layers: { front: scaled, back: [] } });
      updateCutPath(store);
    }))));
    const allowed = allowedShapes(s.layers.front || [], s.assets);
    const shapeChips = p.shapes.map((sh) => {
      const c = chip(`shape:${sh.key}`, sh.label, s.sticker.shape === sh.key, () => {
        store.set({ sticker: { ...s.sticker, shape: sh.key } });
        updateCutPath(store);
      });
      if (!allowed.includes(sh.key)) c.disabled = true;
      return c;
    });
    parts.push(group("Shape", shapeChips));
    if (!allowed.includes("contour")) {
      const why = document.createElement("p");
      why.className = "muted";
      why.textContent = "A JPEG has no transparent background, so the cut can't follow the logo. Use a circle or rounded square, or upload a PNG or SVG.";
      parts.push(why);
    }
  }
  if (p.needsOwner) {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "Large-format orders need the owner's confirmation before the agent quotes them.";
    parts.push(note);
  }
  container.replaceChildren(...parts);
}
