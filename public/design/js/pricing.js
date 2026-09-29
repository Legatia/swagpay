// Live estimate. Policy numbers and rates come from GET /api/pricing so the estimate matches the
// agent's quote; printer costs come from /design/price-table.json.
export function bandPrice(bands, qty) {
  const band = (bands || []).find((b) => qty >= b.minQty && qty <= b.maxQty);
  return band ? band.unitPln : null;
}

export function totalSizes(sizes) {
  return Object.values(sizes || {}).reduce((sum, n) => sum + Math.max(0, Math.floor(Number(n) || 0)), 0);
}

function costPln(sel, table) {
  const t = table?.[sel.product];
  if (!t) return null;
  if (sel.product === "tshirt") {
    const qty = totalSizes(sel.sizes);
    if (qty === 0) return 0;
    let unit = t.garmentPln;
    for (const side of sel.printedSides || []) {
      const price = bandPrice(t.print?.[side], qty);
      if (price == null) return null;
      unit += price;
    }
    return qty * unit + (t.setupPln || 0) + (table.deliveryPln || 0);
  }
  const qty = Math.max(0, Math.floor(Number(sel.quantity) || 0));
  if (qty === 0) return 0;
  const key = sel.product === "sticker" ? String(sel.sticker?.longestSideMm) : sel.options?.size;
  const unit = bandPrice(t[key], qty);
  if (unit == null) return null;
  return qty * unit + (t.setupPln || 0) + (table.deliveryPln || 0);
}

export function estimate(sel, table, pricing) {
  const cost = costPln(sel, table);
  if (cost === 0) return { status: "empty" };
  const rate = pricing?.plnPerUnit?.[sel.currency];
  if (!rate || cost == null) return { status: "quote" };
  const low = Math.floor((cost * (1 + pricing.markupMin) * (1 + pricing.fxBuffer)) / rate);
  const high = Math.ceil((cost * (1 + pricing.markupMax) * (1 + pricing.fxBuffer)) / rate);
  return { status: "ok", currency: sel.currency, low, high };
}

const SYMBOL = { USD: "$", EUR: "€" };

export function formatEstimate(r) {
  if (r.status === "ok") return `Estimate ${SYMBOL[r.currency] ?? ""}${r.low}–${r.high}`;
  if (r.status === "quote") return "The agent will quote this";
  return "";
}

// The backend escalates quotes above perOrderCapUsd to the owner; EUR converts with the same rate
// ratio send_quote uses.
export function capNotice(r, pricing) {
  const cap = pricing?.perOrderCapUsd;
  if (r?.status !== "ok" || !cap || !pricing.plnPerUnit) return null;
  const highUsd = r.currency === "USD" ? r.high : (r.high * pricing.plnPerUnit.EUR) / pricing.plnPerUnit.USD;
  return highUsd > cap ? `Orders over $${cap} need the owner's confirmation.` : null;
}

export async function loadPricing(fetchFn = fetch) {
  try {
    const res = await fetchFn("/api/pricing", { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
