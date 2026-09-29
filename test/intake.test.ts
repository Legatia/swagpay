import { describe, expect, it } from "vitest";
import { IntakeSchema, checkIntakeDates, issueText } from "../src/intake";

const good = {
  eventName: "Builders meetup",
  eventDate: "2026-10-08",
  deliverBy: "2026-10-08T17:00",
  deliveryPlace: "Kolektyw3, Koszykowa 54, Warsaw",
  contactName: "Ana",
  contactEmail: "ana@example.com",
  request: "60 black tees with our logo on the front and 500 stickers",
};
const now = new Date("2026-10-01T10:00:00Z");

describe("intake", () => {
  it("accepts a complete intake", () => {
    const r = IntakeSchema.safeParse(good);
    expect(r.success).toBe(true);
    if (r.success) expect(checkIntakeDates(r.data, now)).toBeNull();
  });

  it("names the bad field", () => {
    const r = IntakeSchema.safeParse({ ...good, contactEmail: "nope" });
    expect(r.success).toBe(false);
    if (!r.success) expect(issueText(r.error)).toMatch(/^contactEmail: /);
  });

  it("rejects a delivery time in the past or after the event day", () => {
    expect(checkIntakeDates({ ...good, deliverBy: "2026-09-30T12:00" }, now)).toMatch(/future/);
    expect(checkIntakeDates({ ...good, deliverBy: "2026-10-09T09:00" }, now)).toMatch(/event day/);
    expect(checkIntakeDates({ ...good, eventDate: "2026-09-29" }, now)).toMatch(/event date/);
    expect(checkIntakeDates({ ...good, deliverBy: "2026-02-30T10:00" }, now)).toMatch(/date/);
  });
});
