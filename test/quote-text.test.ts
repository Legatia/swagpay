import { describe, expect, it } from "vitest";
import { itemsKey } from "../src/order-spec";
import { DEFAULT_POLICY } from "../src/policy";
import { costRequestText, itemLine, priceBand, quoteText, warsawTime } from "../src/quote-text";
import type { QuoteRow } from "../src/quotes";
import { completeSpec } from "./fixtures";

describe("quote texts", () => {
  it("formats Warsaw time", () => {
    expect(warsawTime(new Date("2099-10-03T10:00:00Z"))).toMatch(/^3 Oct 2099,? 12:00$/);
  });

  it("describes items and asks the owner for a cost", () => {
    expect(itemLine(completeSpec.items[0])).toBe("60 × Black tee (screen), black, S 10, M 20, L 20, XL 10, print: front");
    expect(itemLine(completeSpec.items[1])).toBe("500 × Round logo sticker (diecut), 5 × 5 cm");
    const text = costRequestText(7, completeSpec, new Date("2099-10-08T15:00:00Z"), "Kolektyw3", "two colours");
    expect(text.split("\n")).toEqual([
      "Printer cost needed for order 7.",
      "- 60 × Black tee (screen), black, S 10, M 20, L 20, XL 10, print: front",
      "- 500 × Round logo sticker (diecut), 5 × 5 cm",
      expect.stringMatching(/^Deliver by 8 Oct 2099,? 17:00 \(Warsaw\) to Kolektyw3\.$/),
      "Agent's note: two colours",
      "Reply /cost <this #> <PLN gross, delivery included> [printer]",
    ]);
  });

  it("writes the quote the host sees", () => {
    const quote = { id: 12, currency: "USD", price_cents: 38000, deposit_cents: 25750, valid_until: "2099-10-03T10:00:00.000Z" } as QuoteRow;
    expect(quoteText(quote)).toMatch(
      /^Quote #12: 380\.00 USD for the whole order, delivery included\. Deposit: 257\.50 USD, paid in USDC on Arc; the rest is due before delivery\. Valid until 3 Oct 2099,? 12:00 \(Warsaw time\)\. Accept it on this page to get the payment details\.$/,
    );
  });

  it("gives the price band inside the markup limits", () => {
    expect(priceBand(1000, 4, DEFAULT_POLICY)).toEqual({ lo: 360.5, hi: 386.25 });
    expect(priceBand(1000, 4.3, DEFAULT_POLICY)).toEqual({ lo: 335.35, hi: 359.3 });
  });
});

describe("itemsKey", () => {
  it("ignores key order and artwork, and changes with the items", async () => {
    const reordered = { ...completeSpec, items: completeSpec.items.map((i) => Object.fromEntries(Object.entries(i).reverse())) } as typeof completeSpec;
    const key = await itemsKey(completeSpec);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(await itemsKey(reordered)).toBe(key);
    expect(await itemsKey({ ...completeSpec, artwork: [] })).toBe(key);
    expect(await itemsKey({ ...completeSpec, items: [{ ...completeSpec.items[0], quantity: 61 }, completeSpec.items[1]] })).not.toBe(key);
  });
});
