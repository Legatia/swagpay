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

/** A simulated quote at `vendor` for the order (major units, two decimals), always labelled; null when none can be derived. */
export function simulatedQuote(
  order: OrderRow, spec: OrderSpec | null, vendor: VendorRow | null,
): { currency: "PLN" | "EUR" | "GBP" | "USD" | "INR"; amount: number; label: string } | null {
  if (!spec) return null;
  const units = spec.items.reduce((n, i) => n + i.quantity, 0);
  if (!(units > 0)) return null;
  // Default: 25 PLN a unit. arc-c4 replaces this with published price data and the editor's price table.
  return { currency: "PLN", amount: Math.round(units * 25 * 100) / 100, label: `simulated quote from published prices (${SIMULATED})` };
}

/** The labelled line the simulated printer adds to the order thread at a step. Never a real contact detail. */
export function stepMessage(step: PrinterStep, order: OrderRow, vendor: VendorRow | null): string {
  const who = vendor ? `Printer #${vendor.id} ${vendor.name}` : "The printer";
  const what: Record<PrinterStep, string> = { accepted: "accepted the job", proof: "sent a proof", printed: "finished printing", shipped: "shipped the order" };
  return `${who} ${what[step]} for order ${order.id} (${SIMULATED}).`;
}

/** Seconds until a step fires, on the sandbox's fast clock. */
export function stepDelaySeconds(step: PrinterStep): number {
  return { accepted: 30, proof: 60, printed: 90, shipped: 60 }[step];
}
