import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { orderLedger } from "../src/admin-data";
import { renderLedger } from "../src/admin-views";
import { saveOrderSpec } from "../src/db";
import { createEscalation } from "../src/escalations";
import type { OrderSpec } from "../src/order-spec";
import { MAX_EMAIL_BODY, mailtoLink, quoteRequestEmail } from "../src/quote-email";
import { recordAsked } from "../src/quote-requests";
import { completeSpec, newOrderRow } from "./fixtures";

describe("quoteRequestEmail", () => {
  it("writes the request in Polish with every item, the date and the place", () => {
    const m = quoteRequestEmail({ orderId: 12, spec: completeSpec, deliverBy: "2099-10-08T15:00:00.000Z", deliveryPlace: "Kolektyw3, Koszykowa 54, Warszawa" });
    expect(m.subject).toBe("Zapytanie ofertowe: koszulki 60 szt., naklejki 500 szt.");
    expect(m.body).toBe([
      "Dzień dobry,",
      "",
      "prosimy o wycenę zamówienia (Swagpay, zamówienie nr 12):",
      "- koszulki: 60 szt., kolor black, sitodruk, nadruk: przód, rozmiary: S 10, M 20, L 20, XL 10",
      "- naklejki: 500 szt., wycinane po obrysie, 5 × 5 cm",
      "",
      "Termin dostawy: do 2099-10-08, adres: Kolektyw3, Koszykowa 54, Warszawa.",
      "Prosimy o cenę brutto z dostawą oraz czas realizacji.",
      "Pliki z grafiką w załączniku.",
      "",
      "Pozdrawiamy,",
      "Swagpay",
    ].join("\n"));
  });

  it("stays under 1,800 characters", () => {
    const spec: OrderSpec = {
      items: Array.from({ length: 10 }, () => ({ kind: "mug", description: "x".repeat(500), method: "screen", quantity: 100 })),
      artwork: [],
    };
    const m = quoteRequestEmail({ orderId: 1, spec, deliverBy: "2099-10-08T15:00:00.000Z", deliveryPlace: "Gdańsk" });
    expect(m.body.length).toBeLessThanOrEqual(MAX_EMAIL_BODY);
    expect(m.body).toContain("- (pozostałe pozycje w załączniku)");
    expect(m.body).toContain("Pozdrawiamy,\nSwagpay");
  });

  it("builds a mailto link only for a plain address", () => {
    const m = { subject: "Zapytanie ofertowe: koszulki 60 szt.", body: "Dzień dobry,\nza 2 dni & więcej" };
    expect(mailtoLink("biuro@druk.pl", m)).toBe(`mailto:biuro@druk.pl?subject=${encodeURIComponent(m.subject)}&body=${encodeURIComponent(m.body)}`);
    for (const bad of ["biuro@druk.pl?cc=x@y.pl", "bad address", "no-at-sign", "a@b@c.pl"]) expect(mailtoLink(bad, m)).toBeNull();
  });
});

describe("the order page in /admin", () => {
  async function vendor(name: string, extra: { email?: string; website?: string; evidence?: unknown; registered?: string } = {}) {
    return (await env.DB
      .prepare("INSERT INTO vendors (name, city, country, methods, status, email, website, registered_name, evidence, found_by, source_ref, created_at, updated_at) VALUES (?, 'Gdańsk', 'PL', '[\"screen\"]', 'screened', ?, ?, ?, ?, 'agent', ?, 'x', 'x') RETURNING id")
      .bind(name, extra.email ?? null, extra.website ?? null, extra.registered ?? null, extra.evidence ? JSON.stringify(extra.evidence) : null, `test:${crypto.randomUUID()}`)
      .first<{ id: number }>())!.id;
  }

  it("lists the printers the agent picked, with the checks and an email draft", async () => {
    const { order } = await newOrderRow();
    await saveOrderSpec(env.DB, order.id, completeSpec);
    const e = await createEscalation(env.DB, { orderId: order.id, kind: "cost", summary: "Printer cost needed", payload: {} });
    const withEmail = await vendor("Druk Gdańsk", {
      email: "biuro@druk.pl", website: "https://druk.pl", registered: "DRUK GDAŃSK SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ",
      evidence: { nipSeenOn: "https://druk.pl/kontakt", whitelist: { status: "Czynny", date: "2099-10-01" } },
    });
    const noEmail = await vendor("Druk Bez Maila", { website: "https://druk2.pl" });
    await recordAsked(env.DB, { orderId: order.id, escalationId: e.id, vendorIds: [withEmail, noEmail], status: "drafted" });
    const html = renderLedger((await orderLedger(env.DB, order.id))!, "https://explorer.test");
    expect(html).toContain("<h2>Asked printers</h2>");
    expect(html).toContain(`Druk Gdańsk (#${withEmail})`);
    expect(html).toContain("DRUK GDAŃSK SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ");
    expect(html).toContain('href="mailto:biuro@druk.pl?subject=Zapytanie%20ofertowe');
    expect(html).toContain('href="https://druk.pl/kontakt" rel="noreferrer noopener" target="_blank">NIP on the site</a>');
    expect(html).toContain("whitelist: Czynny (2099-10-01)");
    expect(html).toContain('href="https://druk2.pl" rel="noreferrer noopener" target="_blank">Website</a>');
    expect(html.indexOf("<h2>Asked printers</h2>")).toBeLessThan(html.indexOf("<h2>Offers</h2>"));
  });

  it("shows no section when the agent asked no printer", async () => {
    const { order } = await newOrderRow();
    const html = renderLedger((await orderLedger(env.DB, order.id))!, "https://explorer.test");
    expect(html).not.toContain("Asked printers");
  });
});
