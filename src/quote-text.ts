import { TOKEN_FOR, formatCents } from "./money";
import type { OrderSpec } from "./order-spec";
import { quoteCostBasis, type Policy } from "./policy";
import type { QuoteRow } from "./quotes";

const WARSAW = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Warsaw", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
});

export function warsawTime(d: Date): string {
  return WARSAW.format(d);
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function itemLine(item: OrderSpec["items"][number]): string {
  const parts = [`${item.quantity} × ${oneLine(item.description)}${item.method ? ` (${item.method})` : ""}`];
  if (item.colour) parts.push(oneLine(item.colour));
  if (item.sizes) {
    const sizes = Object.entries(item.sizes).filter(([, n]) => n).map(([s, n]) => `${s} ${n}`).join(", ");
    if (sizes) parts.push(sizes);
  }
  if (item.printAreas?.length) parts.push(`print: ${item.printAreas.join(", ")}`);
  if (item.sizeCm) parts.push(`${item.sizeCm.w} × ${item.sizeCm.h} cm`);
  return parts.join(", ");
}

export function costRequestText(orderNumber: number, spec: OrderSpec, deliverBy: Date, place: string, note?: string): string {
  return [
    `Printer cost needed for order ${orderNumber}.`,
    ...spec.items.map((i) => `- ${itemLine(i)}`),
    `Deliver by ${warsawTime(deliverBy)} (Warsaw) to ${oneLine(place)}.`,
    ...(note ? [`Agent's note: ${oneLine(note)}`] : []),
    "Reply /cost <this #> <PLN gross, delivery included> [printer]",
  ].join("\n");
}

export function quoteText(q: QuoteRow): string {
  return `Quote #${q.id}: ${formatCents(q.price_cents)} ${q.currency} for the whole order, delivery included. Deposit: ${formatCents(q.deposit_cents)} ${q.currency}, paid in ${TOKEN_FOR[q.currency]} on Arc; the rest is due before delivery. Valid until ${warsawTime(new Date(q.valid_until))} (Warsaw time). Accept it on this page to get the payment details.`;
}

/** The prices the markup band allows, in the quote currency, rounded inward to the cent. */
export function priceBand(costPln: number, plnPerUnit: number, p: Policy): { lo: number; hi: number } {
  const basis = quoteCostBasis({ price: 0, currency: "USD", costPln, plnPerUnit, usdPerUnit: 1 }, p);
  return { lo: Math.ceil(basis * (1 + p.markupMin) * 100) / 100, hi: Math.floor(basis * (1 + p.markupMax) * 100) / 100 };
}
