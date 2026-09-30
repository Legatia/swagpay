import { describe, expect, it } from "vitest";
import { REQUEST_MAX, SendError, buildIntake, plainError, progressText, requestText, sha256, withFileIds } from "../../public/design/js/submit.js";

const contact = { eventName: "  Builders meetup ", eventDate: "2026-10-20", deliverBy: "2026-10-19T12:00", deliveryPlace: " Kolektyw3, Koszykowa 54, Warsaw ", contactName: " Ada ", contactEmail: " ada@example.com " };

describe("requestText", () => {
  it("says the order comes from the editor", () => {
    expect(requestText("60 black t-shirts.")).toBe("Designed in the Swagpay editor. 60 black t-shirts.");
  });
  it("cuts long requests to the limit", () => {
    const t = requestText("x".repeat(5000));
    expect(t.length).toBe(REQUEST_MAX);
    expect(t.endsWith("…")).toBe(true);
  });
  it("never splits a character in two", () => {
    // The 32-character prefix plus 3966 letters puts the first emoji's high surrogate exactly at
    // the cut point (index 3998), so a naive slice would end on half an emoji.
    const summary = "a".repeat(REQUEST_MAX - 34) + "😀".repeat(10);
    const t = requestText(summary);
    expect(t.length).toBeLessThanOrEqual(REQUEST_MAX);
    expect(/[\uD800-\uDBFF]…$/.test(t)).toBe(false);
  });
});

describe("buildIntake", () => {
  it("trims the fields and marks the design as pending", () => {
    expect(buildIntake(contact, "60 black t-shirts.")).toEqual({
      eventName: "Builders meetup",
      eventDate: "2026-10-20",
      deliverBy: "2026-10-19T12:00",
      deliveryPlace: "Kolektyw3, Koszykowa 54, Warsaw",
      contactName: "Ada",
      contactEmail: "ada@example.com",
      request: "Designed in the Swagpay editor. 60 black t-shirts.",
      designPending: true,
    });
  });
  it("treats missing fields as empty strings", () => {
    expect(buildIntake({}, "x").eventName).toBe("");
  });
});

describe("withFileIds", () => {
  const spec = { version: 1, files: { "logo-1": { role: "artwork" }, "mockup-front": { role: "mockup" } } };
  it("adds each upload's fileId", () => {
    const out = withFileIds(spec, { "logo-1": { hash: "a", fileId: "id-1" }, "mockup-front": { hash: "b", fileId: "id-2" }, stale: { hash: "c", fileId: "id-3" } });
    expect(out.files).toEqual({ "logo-1": { role: "artwork", fileId: "id-1" }, "mockup-front": { role: "mockup", fileId: "id-2" } });
    expect(spec.files["logo-1"].fileId).toBeUndefined();
  });
  it("throws a SendError with the order link when a file is missing", () => {
    try {
      withFileIds(spec, { "logo-1": { hash: "a", fileId: "id-1" } }, "/o/abc");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SendError);
      expect(err.url).toBe("/o/abc");
    }
  });
});

describe("plain errors", () => {
  it("names fields the way the form does", () => {
    expect(plainError("eventName: Too small: expected string to have >=2 characters")).toBe("Event name: Too small: expected string to have >=2 characters");
    expect(plainError("contactEmail: Invalid email address")).toBe("Email: Invalid email address");
  });
  it("rewrites the date messages", () => {
    expect(plainError("the event date has passed")).toBe("The event date has passed");
    expect(plainError("deliverBy must be on or before the event day")).toBe("The delivery time must be on or before the event day");
    expect(plainError("eventDate is not a real date")).toBe("The event date is not a real date");
  });
  it("has a fallback", () => {
    expect(plainError("")).toBe("Something went wrong. Please try again.");
    expect(plainError(undefined)).toBe("Something went wrong. Please try again.");
  });
});

describe("progressText", () => {
  it("describes each stage", () => {
    expect(progressText({ stage: "prepare" })).toBe("Preparing your files…");
    expect(progressText({ stage: "check" })).toBe("Checking you're human. If a box appears above, tick it.");
    expect(progressText({ stage: "create" })).toBe("Creating your order…");
    expect(progressText({ stage: "upload", done: 1, total: 5 })).toBe("Uploading files (2 of 5)…");
    expect(progressText({ stage: "design" })).toBe("Attaching your design…");
    expect(progressText({ stage: "done" })).toBe("Done. Opening your order…");
  });
});

describe("sha256", () => {
  it("hashes a blob to lowercase hex", async () => {
    expect(await sha256(new Blob(["abc"]))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
