import { describe, expect, it } from "vitest";
import { itemsKey } from "../src/order-spec";
import { DEFAULT_POLICY } from "../src/policy";
import { costRequestText, costRequestWithoutPrinters, itemLine, priceBand, quoteText, warsawTime } from "../src/quote-text";
import type { QuoteRow } from "../src/quotes";
import { completeSpec } from "./fixtures";

describe("quote texts", () => {
  it("formats Warsaw time", () => {
    expect(warsawTime(new Date("2099-10-03T10:00:00Z"))).toMatch(/^3 Oct 2099,? 12:00$/);
  });

  it("describes items and asks the owner for a cost", () => {
    expect(itemLine(completeSpec.items[0])).toBe("60 × Black tee (screen), black, S 10, M 20, L 20, XL 10, print: front");
    expect(itemLine(completeSpec.items[1])).toBe("500 × Round logo sticker (diecut), 5 × 5 cm");
    const text = costRequestText(7, completeSpec, new Date("2099-10-08T15:00:00Z"), "Kolektyw3", "two colours", null);
    expect(text.split("\n")).toEqual([
      "Printer cost needed for order 7.",
      "- 60 × Black tee (screen), black, S 10, M 20, L 20, XL 10, print: front",
      "- 500 × Round logo sticker (diecut), 5 × 5 cm",
      expect.stringMatching(/^Deliver by 8 Oct 2099,? 17:00 \(Warsaw\) to Kolektyw3\.$/),
      "Agent's note: two colours",
      "City not recognised from the delivery place; pick a printer yourself.",
      "Reply /cost <this #> <amount> [PLN|EUR|GBP|USD|INR] [v<printer #>] [note]",
    ]);
  });

  it("lists suggested printers, or says none was found", () => {
    const by = new Date("2099-10-08T15:00:00Z");
    const some = costRequestText(7, completeSpec, by, "Kolektyw3", undefined, ["v3 A (screen; covers all; 0 jobs, 0 on time)", "v4 B (screen; covers 1 of 2; 2 jobs, 1 on time)"]).split("\n");
    expect(some.slice(-4)).toEqual([
      "Suggested printers:", "v3 A (screen; covers all; 0 jobs, 0 on time)", "v4 B (screen; covers 1 of 2; 2 jobs, 1 on time)",
      "Reply /cost <this #> <amount> [PLN|EUR|GBP|USD|INR] [v<printer #>] [note]",
    ]);
    const none = costRequestText(7, completeSpec, by, "Kolektyw3", undefined, []).split("\n");
    expect(none.slice(-2)).toEqual(["No screened printer found for this city yet.", "Reply /cost <this #> <amount> [PLN|EUR|GBP|USD|INR] [v<printer #>] [note]"]);
  });

  it("drops the printer suggestions (and all after them) from a cost request forwarded to the order agent", () => {
    const by = new Date("2099-10-08T15:00:00Z");
    const plain = costRequestText(7, completeSpec, by, "Kolektyw3", "two colours");
    const head = plain.split("\n").slice(0, -1).join("\n");
    const cases: Array<string[] | null> = [["v3 Secret Print (screen; covers all; 0 jobs, 0 on time)"], [], null];
    for (const suggestions of cases) {
      const text = costRequestText(7, completeSpec, by, "Kolektyw3", "two colours", suggestions);
      expect(costRequestWithoutPrinters(text)).toBe(head);
    }
    // A summary without suggestions (older requests) is left as it is.
    expect(costRequestWithoutPrinters(plain)).toBe(plain);
    expect(costRequestWithoutPrinters("Printer cost again")).toBe("Printer cost again");
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
