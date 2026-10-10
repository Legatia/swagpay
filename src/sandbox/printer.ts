// src/sandbox/printer.ts — SHELL: arc-c4 fills in the bodies (keep the exports and signatures).
import type { OrderRow } from "../db";
import type { OrderSpec } from "../order-spec";
import type { VendorRow } from "../vendors";
import { cityKey } from "../discovery/names";

export const SIMULATED = "simulated: this printer has not been contacted";

/** The simulated printer's steps after the deposit, in order. `printed` also runs the owner's /printed. Delivery stays the host's "We received it". */
export type PrinterStep = "accepted" | "proof" | "printed" | "shipped";
export const PRINTER_STEPS: PrinterStep[] = ["accepted", "proof", "printed", "shipped"];

export function nextStep(step: PrinterStep): PrinterStep | null {
  const i = PRINTER_STEPS.indexOf(step);
  return i >= 0 && i < PRINTER_STEPS.length - 1 ? PRINTER_STEPS[i + 1] : null;
}

// Published-price basis in PLN, gross, delivery once per order. Sources: the editor's price table
// (NeoNadruki DTF, assumed garment and courier) and Sticky Studio's 5x5 cm die-cut table
// (event-swag/data). Large format has no published price: 150 PLN a piece is an inference.
const DELIVERY_PLN = 60;
const TEE_GARMENT_PLN = 20;
const teePrintPln = (qty: number) => (qty < 50 ? 17 : qty < 100 ? 15 : 13);
const stickerPln = (qty: number) => (qty <= 100 ? 48 : qty <= 500 ? 96 : 192 * Math.ceil(qty / 1000));
const OTHER_PLN = 150;
// Approximate NBP mid rates (PLN per unit); the sandbox's quote is labelled approximate anyway.
const PLN_PER: Record<"PLN" | "EUR" | "GBP" | "USD" | "INR", number> = { PLN: 1, EUR: 4.27, GBP: 5.05, USD: 3.95, INR: 0.046 };
const SCALE = 0.01;
const FLOOR_USD = 0.75;
const CAP_USD = 4;

function currencyFor(vendor: VendorRow | null): keyof typeof PLN_PER {
  const c = vendor?.country?.toUpperCase();
  if (!c || c === "PL") return "PLN";
  if (c === "GB") return "GBP";
  if (c === "IN") return "INR";
  if (c === "US") return "USD";
  return "EUR";
}

function basePln(spec: OrderSpec): number {
  let total = DELIVERY_PLN;
  for (const item of spec.items) {
    if (item.kind === "tshirt") {
      const sides = Math.max(1, item.printAreas?.length ?? 1);
      total += item.quantity * (TEE_GARMENT_PLN + sides * teePrintPln(item.quantity));
    } else if (item.kind === "sticker") {
      total += stickerPln(item.quantity);
    } else {
      total += item.quantity * OTHER_PLN;
    }
  }
  return total;
}

/** A simulated quote at `vendor` for the order (major units, two decimals), always labelled; null when none can be derived. */
export function simulatedQuote(
  order: OrderRow, spec: OrderSpec | null, vendor: VendorRow | null,
): { currency: "PLN" | "EUR" | "GBP" | "USD" | "INR"; amount: number; label: string } | null {
  if (!spec || !spec.items.some((i) => i.quantity > 0)) return null;
  const scaledPln = basePln(spec) * SCALE;
  const floorPln = FLOOR_USD * PLN_PER.USD;
  const capPln = CAP_USD * PLN_PER.USD;
  const pln = Math.min(Math.max(scaledPln, floorPln), capPln);
  const currency = currencyFor(vendor);
  const amount = Math.round((pln / PLN_PER[currency]) * 100) / 100;
  const capped = scaledPln > capPln ? ", capped at about $4 so a full order fits the faucet" : "";
  return { currency, amount, label: `simulated quote from published prices, scaled to 1% for the testnet faucet${capped} (${SIMULATED})` };
}

/** The labelled line the simulated printer adds to the order thread at a step. Never a real contact detail. */
export function stepMessage(step: PrinterStep, order: OrderRow, vendor: VendorRow | null): string {
  const who = vendor ? `${vendor.name} (${vendor.city})` : "The printer";
  const what: Record<PrinterStep, string> = {
    accepted: "accepted the job and scheduled printing",
    proof: "sent a proof photo; it matches the design shown on this order page",
    printed: "finished printing",
    shipped: "shipped the order to the venue",
  };
  return `${who} ${what[step]} (order ${order.id}, ${SIMULATED}).`;
}

/** Seconds until a step fires, on the sandbox's fast clock. */
export function stepDelaySeconds(step: PrinterStep): number {
  return { accepted: 30, proof: 60, printed: 90, shipped: 60 }[step];
}

// Delivery options for a simulated offer. Base costs are estimates for Poland in PLN (a same-day
// courier in town, a 1–2 day courier, a parcel locker, an international courier), scaled to 1% like
// simulatedQuote so a quote plus its dearest option stays inside the testnet faucet budget.
export type DeliveryMethod = "pickup" | "printer_courier" | "courier" | "same_day" | "parcel_locker";
const DELIVERY_SCALE = 0.01;

function addWorkingDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return d.toISOString().slice(0, 10);
}

/** 2 options per printer: same city, elsewhere in Poland, or abroad (by city key and country). */
export function simulatedDeliveries(
  vendor: VendorRow | null, deliveryCityKey: string | null, readyBy: string,
): Array<{ method: DeliveryMethod; costPln: number; arrivesAt: string; note?: string }> {
  const opt = (method: DeliveryMethod, basePln: number, workingDays: number, what: string) => ({
    method,
    costPln: Math.round(basePln * DELIVERY_SCALE * 100) / 100,
    arrivesAt: addWorkingDays(readyBy, workingDays),
    note: `${what}, scaled to 1% for the testnet faucet (${SIMULATED})`,
  });
  const abroad = vendor?.country ? vendor.country.toUpperCase() !== "PL" : false;
  if (abroad) {
    return [opt("courier", 90, 5, "International courier, about 5 working days"), opt("printer_courier", 150, 3, "The printer's express courier, about 3 working days")];
  }
  const sameCity = !!vendor?.city && !!deliveryCityKey && cityKey(vendor.city) === cityKey(deliveryCityKey);
  if (sameCity) {
    return [opt("pickup", 0, 0, "Pickup at the printer"), opt("same_day", 60, 0, "Same-day courier in town")];
  }
  return [opt("courier", 25, 2, "Courier, 1–2 working days"), opt("parcel_locker", 15, 2, "Parcel locker, about 2 working days")];
}
