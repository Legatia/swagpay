// The quote request the owner sends a printer the agent picked (production): Polish, plain text, opened as a mailto: draft.
import type { OrderSpec } from "./order-spec";
import { warsawDate } from "./time";

export const MAX_EMAIL_BODY = 1800;

const METHOD_PL: Record<string, string> = { screen: "sitodruk", dtg: "DTG", dtf: "DTF", diecut: "wycinane po obrysie", banner: "baner" };
const AREA_PL: Record<string, string> = { front: "przód", back: "tył", "left sleeve": "lewy rękaw", "right sleeve": "prawy rękaw" };

const oneLine = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

function itemLine(i: OrderSpec["items"][number]): string {
  const method = i.method ? METHOD_PL[i.method] ?? oneLine(i.method, 20) : "metoda do ustalenia";
  if (i.kind === "tshirt") {
    const sizes = i.sizes ? Object.entries(i.sizes).filter(([, n]) => (n ?? 0) > 0).map(([s, n]) => `${s} ${n}`).join(", ") : "do ustalenia";
    const areas = (i.printAreas ?? []).map((a) => AREA_PL[a.toLowerCase()] ?? oneLine(a, 40)).join(", ") || "do ustalenia";
    return `- koszulki: ${i.quantity} szt., kolor ${oneLine(i.colour ?? "do ustalenia", 40)}, ${method}, nadruk: ${areas}, rozmiary: ${sizes}`;
  }
  if (i.kind === "sticker") return `- naklejki: ${i.quantity} szt., ${method}${i.sizeCm ? `, ${i.sizeCm.w} × ${i.sizeCm.h} cm` : ""}`;
  return `- ${oneLine(i.description, 200)}: ${i.quantity} szt., ${method}`;
}

/** Subject and body (at most 1,800 characters: items that don't fit are left to the attachment). */
export function quoteRequestEmail(p: { orderId: number; spec: OrderSpec; deliverBy: string; deliveryPlace: string }): { subject: string; body: string } {
  const counts = p.spec.items.map((i) => `${i.kind === "tshirt" ? "koszulki" : i.kind === "sticker" ? "naklejki" : oneLine(i.kind, 20)} ${i.quantity} szt.`);
  const subject = `Zapytanie ofertowe: ${counts.join(", ")}`.slice(0, 150);
  const head = ["Dzień dobry,", "", `prosimy o wycenę zamówienia (Swagpay, zamówienie nr ${p.orderId}):`];
  const tail = [
    "",
    `Termin dostawy: do ${warsawDate(new Date(p.deliverBy))}, adres: ${oneLine(p.deliveryPlace, 120)}.`,
    "Prosimy o cenę brutto z dostawą oraz czas realizacji.",
    "Pliki z grafiką w załączniku.",
    "",
    "Pozdrawiamy,",
    "Swagpay",
  ];
  const lines = p.spec.items.map(itemLine);
  let body = [...head, ...lines, ...tail].join("\n");
  while (body.length > MAX_EMAIL_BODY && lines.length > 1) {
    lines.pop();
    body = [...head, ...lines, "- (pozostałe pozycje w załączniku)", ...tail].join("\n");
  }
  return { subject, body: body.slice(0, MAX_EMAIL_BODY) };
}

const PLAIN_ADDRESS = /^[^\s@?&#<>"',;:()]+@[^\s@?&#<>"',;:()]+\.[^\s@?&#<>"',;:()]+$/;

/** A mailto: link with the subject and body filled in; null unless `to` is a plain address. */
export function mailtoLink(to: string, mail: { subject: string; body: string }): string | null {
  if (!PLAIN_ADDRESS.test(to)) return null;
  return `mailto:${to}?subject=${encodeURIComponent(mail.subject)}&body=${encodeURIComponent(mail.body)}`;
}
