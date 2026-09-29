import { describe, expect, it } from "vitest";
import { businessDaysBetween, isPolishBusinessDay, leadTimeCutoff, warsawDate, warsawLocalToUtc } from "../src/time";

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

  it("finds the first Warsaw midnight from which the lead time no longer fits", () => {
    const monday = new Date("2026-10-05T08:00:00Z");
    // Tue-Fri and Mon are 5 business days; from Wednesday 00:00 only Thu, Fri, Mon (3) remain.
    expect(leadTimeCutoff(monday, new Date("2026-10-13T15:00:00Z"), 4).toISOString()).toBe("2026-10-06T22:00:00.000Z");
    // Already short: the cutoff is tonight's midnight.
    expect(leadTimeCutoff(monday, new Date("2026-10-08T15:00:00Z"), 4).toISOString()).toBe("2026-10-05T22:00:00.000Z");
    // A deadline before that midnight is the cutoff itself.
    expect(leadTimeCutoff(monday, new Date("2026-10-05T18:00:00Z"), 2).toISOString()).toBe("2026-10-05T18:00:00.000Z");
  });

  it("uses the right offset across the DST change", () => {
    // From Tuesday 27 Oct 00:00 (CET, 23:00 UTC the day before) only Wed and Thu remain before Friday 30 Oct.
    expect(leadTimeCutoff(new Date("2026-10-23T08:00:00Z"), new Date("2026-10-30T15:00:00Z"), 3).toISOString()).toBe("2026-10-26T23:00:00.000Z");
  });

  it("stops looking 60 days ahead", () => {
    expect(leadTimeCutoff(new Date("2026-10-05T08:00:00Z"), new Date("2027-06-01T10:00:00Z"), 4).toISOString()).toBe(warsawLocalToUtc("2026-12-04T00:00").toISOString());
  });
});
