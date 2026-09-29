import { describe, expect, it } from "vitest";
import { formatCents, formatUnits, isAddress, tagOf, taggedUnits, TOKEN_FOR } from "../src/money";

describe("money", () => {
  it("puts the tag in the last four of six decimals", () => {
    expect(taggedUnits(41237, 42)).toBe(412370042);
    expect(tagOf(412370042)).toBe(42);
    expect(() => taggedUnits(41237, 0)).toThrow();
    expect(() => taggedUnits(41237, 10_000)).toThrow();
    expect(() => taggedUnits(0, 5)).toThrow();
    expect(() => taggedUnits(12.5, 5)).toThrow();
  });

  it("formats amounts without floats", () => {
    expect(formatUnits(412370042)).toBe("412.370042");
    expect(formatUnits(5)).toBe("0.000005");
    expect(formatUnits(-1_000_000)).toBe("-1.000000");
    expect(formatCents(41237)).toBe("412.37");
    expect(formatCents(5)).toBe("0.05");
    expect(formatCents(-5)).toBe("-0.05");
  });

  it("maps currencies to tokens and checks addresses", () => {
    expect(TOKEN_FOR).toEqual({ USD: "USDC", EUR: "EURC" });
    expect(isAddress("0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1")).toBe(true);
    expect(isAddress("")).toBe(false);
    expect(isAddress("0x123")).toBe(false);
    expect(isAddress(undefined)).toBe(false);
  });
});
