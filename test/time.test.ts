import { describe, expect, it } from "vitest";
import { businessDaysBetween, isPolishBusinessDay, warsawDate, warsawLocalToUtc } from "../src/time";

describe("warsaw time", () => {
  it("reads the Warsaw calendar date", () => {
    expect(warsawDate(new Date("2026-10-07T22:30:00Z"))).toBe("2026-10-08"); // 00:30 CEST
    expect(warsawDate(new Date("2026-12-01T22:59:00Z"))).toBe("2026-12-01"); // 23:59 CET
  });

  it("converts Warsaw wall time to UTC across the DST change on 2026-10-25", () => {
    expect(warsawLocalToUtc("2026-10-08T17:00").toISOString()).toBe("2026-10-08T15:00:00.000Z");
    expect(warsawLocalToUtc("2026-11-05T17:00").toISOString()).toBe("2026-11-05T16:00:00.000Z");
  });

  it("rejects malformed local times", () => {
    expect(() => warsawLocalToUtc("2026-10-08 17:00")).toThrow();
    expect(() => warsawLocalToUtc("2026-02-30T10:00")).toThrow();
  });

  it("knows weekends and Polish holidays", () => {
    expect(isPolishBusinessDay("2026-10-09")).toBe(true); // Friday
    expect(isPolishBusinessDay("2026-10-10")).toBe(false); // Saturday
    expect(isPolishBusinessDay("2026-11-11")).toBe(false); // Independence Day, Wednesday
    expect(isPolishBusinessDay("2026-12-24")).toBe(false); // Christmas Eve, Thursday
  });

  it("counts whole business days between today and the deadline day", () => {
    const monday = new Date("2026-10-05T08:00:00Z");
    expect(businessDaysBetween(monday, new Date("2026-10-08T15:00:00Z"))).toBe(2); // Tue, Wed
    expect(businessDaysBetween(monday, new Date("2026-10-13T15:00:00Z"))).toBe(5); // Tue-Fri, Mon
    expect(businessDaysBetween(new Date("2026-11-09T08:00:00Z"), new Date("2026-11-13T15:00:00Z"))).toBe(2); // Tue, Thu (Wed 11 Nov is a holiday)
    expect(businessDaysBetween(monday, new Date("2026-10-05T18:00:00Z"))).toBe(0);
  });
});
