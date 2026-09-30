import { describe, expect, it } from "vitest";
import { REQUEST_MAX, SendError, buildIntake, plainError, progressText, requestText, sendOrder, sha256, withFileIds } from "../../public/design/js/submit.js";

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

const spec = {
  version: 1,
  product: "tshirt",
  files: { "logo-1": { role: "artwork" }, "mockup-front": { role: "mockup" }, "print-front": { role: "print" } },
};
const files = [
  { key: "logo-1", role: "artwork", name: "logo-1.png", blob: new Blob(["logo"], { type: "image/png" }) },
  { key: "mockup-front", role: "mockup", name: "mockup-front.png", blob: new Blob(["mock"], { type: "image/png" }) },
  { key: "print-front", role: "print", name: "print-front.svg", blob: new Blob(["<svg/>"], { type: "image/svg+xml" }) },
];
const TOKEN = "t".repeat(43);
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A fake backend: each route answers from a queue, then from its default.
function backend(overrides = {}) {
  const calls = [];
  let n = 0;
  const routes = {
    create: overrides.create ?? [],
    upload: overrides.upload ?? [],
    design: overrides.design ?? [],
  };
  const fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const call = { url, method, init };
    calls.push(call);
    const key = url === "/api/orders" ? "create" : url.endsWith("/artwork") ? "upload" : url.endsWith("/design") ? "design" : null;
    const next = routes[key]?.shift();
    if (next instanceof Error) throw next;
    if (next) return next;
    if (key === "create") return json(201, { token: TOKEN, url: `/o/${TOKEN}` });
    if (key === "upload") return json(201, { fileId: `00000000-0000-4000-8000-00000000000${++n}` });
    if (key === "design") return json(201, { ok: true });
    return json(404, { error: "not found" });
  };
  return { calls, fetch };
}

function deps(fake, extra = {}) {
  const saved = [];
  const slept = [];
  let tokens = 0;
  return {
    saved,
    slept,
    tokenCount: () => tokens,
    deps: {
      fetch: fake.fetch,
      nextToken: async () => `turnstile-${++tokens}`,
      hash: async (blob) => `h:${await blob.text()}`,
      sleep: async (ms) => void slept.push(ms),
      onProgress: () => {},
      savePending: (p) => saved.push(p),
      ...extra,
    },
  };
}

const intake = { eventName: "Builders meetup", request: "Designed in the Swagpay editor. x", designPending: true };
const paths = (calls) => calls.map((c) => `${c.method} ${c.url.replace(TOKEN, "<t>")}`);

describe("sendOrder", () => {
  it("creates the order, uploads each file with its role, then attaches the design", async () => {
    const fake = backend();
    const d = deps(fake);
    const out = await sendOrder({ spec, files, intake, pending: null, deps: d.deps });
    expect(out).toEqual({ url: `/o/${TOKEN}` });
    expect(paths(fake.calls)).toEqual([
      "POST /api/orders",
      "POST /api/o/<t>/artwork",
      "POST /api/o/<t>/artwork",
      "POST /api/o/<t>/artwork",
      "POST /api/o/<t>/design",
    ]);
    expect(JSON.parse(fake.calls[0].init.body)).toEqual({ ...intake, turnstile: "turnstile-1" });
    const roles = fake.calls.slice(1, 4).map((c) => c.init.body.get("role"));
    expect(roles).toEqual(["artwork", "mockup", "print"]);
    expect(fake.calls[1].init.body.get("file").name).toBe("logo-1.png");
    const design = JSON.parse(fake.calls[4].init.body);
    expect(design.files["logo-1"]).toEqual({ role: "artwork", fileId: "00000000-0000-4000-8000-000000000001" });
    expect(d.saved[0]).toEqual({ token: TOKEN, url: `/o/${TOKEN}`, uploaded: {} });
    expect(Object.keys(d.saved.at(-1).uploaded)).toEqual(["logo-1", "mockup-front", "print-front"]);
  });

  it("gives every request a timeout signal, so a stalled one turns into a retry", async () => {
    const fake = backend();
    const d = deps(fake);
    await sendOrder({ spec, files, intake, pending: null, deps: d.deps });
    expect(fake.calls).toHaveLength(5);
    for (const c of fake.calls) expect(c.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("resumes an order that already exists", async () => {
    const fake = backend();
    const d = deps(fake);
    await sendOrder({ spec, files, intake, pending: { token: TOKEN, url: `/o/${TOKEN}`, uploaded: {} }, deps: d.deps });
    expect(paths(fake.calls)[0]).toBe("POST /api/o/<t>/artwork");
    expect(fake.calls.some((c) => c.url === "/api/orders")).toBe(false);
    expect(d.tokenCount()).toBe(0);
  });

  it("re-uploads only changed files", async () => {
    const fake = backend();
    const d = deps(fake);
    const pending = {
      token: TOKEN,
      url: `/o/${TOKEN}`,
      uploaded: {
        "logo-1": { hash: "h:logo", fileId: "11111111-1111-4111-8111-111111111111" },
        "mockup-front": { hash: "h:old mockup", fileId: "22222222-2222-4222-8222-222222222222" },
      },
    };
    await sendOrder({ spec, files, intake, pending, deps: d.deps });
    const uploads = fake.calls.filter((c) => c.url.endsWith("/artwork")).map((c) => c.init.body.get("file").name);
    expect(uploads).toEqual(["mockup-front.png", "print-front.svg"]);
    const design = JSON.parse(fake.calls.at(-1).init.body);
    expect(design.files["logo-1"].fileId).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("retries a failing step with backoff", async () => {
    const fake = backend({ upload: [json(503, { error: "busy" }), json(503, { error: "busy" })] });
    const d = deps(fake);
    await sendOrder({ spec, files, intake, pending: null, deps: d.deps });
    expect(d.slept).toEqual([500, 1500]);
  });

  it("gives up after three network failures with a plain message", async () => {
    const down = () => new TypeError("Failed to fetch");
    const fake = backend({ create: [down(), down(), down()] });
    const d = deps(fake);
    await expect(sendOrder({ spec, files, intake, pending: null, deps: d.deps })).rejects.toMatchObject({
      message: "Swagpay couldn't be reached. Check your connection and send again; your design is kept.",
      url: null,
    });
    expect(fake.calls.length).toBe(3);
  });

  it("gets a fresh token after a 403", async () => {
    const fake = backend({ create: [json(403, { error: "Please complete the human check and try again." })] });
    const d = deps(fake);
    await sendOrder({ spec, files, intake, pending: null, deps: d.deps });
    expect(d.tokenCount()).toBe(2);
    expect(JSON.parse(fake.calls[1].init.body).turnstile).toBe("turnstile-2");
    expect(d.slept).toEqual([]);
  });

  it("does not retry a rejected intake", async () => {
    const fake = backend({ create: [json(400, { error: "the event date has passed" })] });
    const d = deps(fake);
    await expect(sendOrder({ spec, files, intake, pending: null, deps: d.deps })).rejects.toMatchObject({ message: "The event date has passed", url: null });
    expect(fake.calls.length).toBe(1);
  });

  it("stops at the file limit with the order link", async () => {
    const fake = backend({ upload: [json(400, { error: "an order can have up to 10 files" })] });
    const d = deps(fake);
    await expect(sendOrder({ spec, files, intake, pending: null, deps: d.deps })).rejects.toMatchObject({
      message: "This order already has as many files as it can take. Continue on your order page and tell the agent what changed.",
      url: `/o/${TOKEN}`,
    });
  });

  it("starts over when the order is gone", async () => {
    const fake = backend({ upload: [json(404, { error: "order not found" })] });
    const d = deps(fake);
    const pending = { token: TOKEN, url: `/o/${TOKEN}`, uploaded: {} };
    await expect(sendOrder({ spec, files, intake, pending, deps: d.deps })).rejects.toMatchObject({
      message: "That order no longer exists. Send again to start a new one.",
      reset: true,
      url: null,
    });
  });

  it("explains a design that can't change any more", async () => {
    const fake = backend({ design: [json(409, { error: "A quote was already accepted; the design can't change now." })] });
    const d = deps(fake);
    await expect(sendOrder({ spec, files, intake, pending: null, deps: d.deps })).rejects.toMatchObject({
      message: "A quote was already accepted, so the design can't change now. Continue on your order page.",
      url: `/o/${TOKEN}`,
    });
  });

  it("explains a rejected design in plain words", async () => {
    const fake = backend({ design: [json(400, { error: 'files["logo-1"]: no upload with fileId x on this order' })] });
    const d = deps(fake);
    await expect(sendOrder({ spec, files, intake, pending: null, deps: d.deps })).rejects.toMatchObject({
      message: "Your design couldn't be attached. Send again, or continue on your order page and tell the agent.",
      url: `/o/${TOKEN}`,
    });
  });

  it("refuses a design that grew past 64 KB once the file ids were added", async () => {
    const big = { ...spec, pad: "x".repeat(64 * 1024) };
    const fake = backend();
    const d = deps(fake);
    await expect(sendOrder({ spec: big, files, intake, pending: null, deps: d.deps })).rejects.toMatchObject({ url: `/o/${TOKEN}` });
    expect(fake.calls.some((c) => c.url.endsWith("/design"))).toBe(false);
  });

  it("reports progress through each stage", async () => {
    const fake = backend();
    const seen = [];
    const d = deps(fake, { onProgress: (p) => seen.push(p.stage) });
    await sendOrder({ spec, files, intake, pending: null, deps: d.deps });
    expect(seen).toEqual(["check", "create", "upload", "upload", "upload", "design"]);
  });
});
