// src/sandbox/printer.ts — SHELL: arc-c4 fills in the bodies (keep the exports and signatures).
import type { OrderRow } from "../db";
import type { OrderSpec } from "../order-spec";
import type { VendorRow } from "../vendors";

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
const FLOOR_USD = 0.5;
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
