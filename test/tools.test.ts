import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/policy";
import { EMPTY_SPEC, type OrderSpec } from "../src/order-spec";
import { TOOL_DEFINITIONS, makeHandlers, type ArtworkFile, type ToolContext } from "../src/agent/tools";
import type { NewDecision } from "../src/db";

function fakeCtx(files: ArtworkFile[] = []) {
  const state = { spec: structuredClone(EMPTY_SPEC) as OrderSpec, posted: [] as string[], decisions: [] as Omit<NewDecision, "orderId">[] };
  const ctx: ToolContext = {
    policy: DEFAULT_POLICY,
    async getSpec() { return structuredClone(state.spec); },
    async saveSpec(s) { state.spec = structuredClone(s); },
    async postToHost(t) { state.posted.push(t); },
    async loadArtwork(id) { return files.find((f) => f.fileId === id) ?? null; },
    async logDecision(d) { state.decisions.push(d); },
  };
  return { ctx, state, h: makeHandlers(ctx) };
}

const tee = { kind: "tshirt", description: "Black tee", method: "screen", quantity: 60, colour: "black",
  sizes: { S: 10, M: 20, L: 20, XL: 10 }, printAreas: ["front"] };

describe("tool definitions", () => {
  it("defines the three intake tools with object schemas that require a reason", () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual(["ask_host", "update_order", "check_artwork"]);
    for (const t of TOOL_DEFINITIONS) {
      expect(t.input_schema.type).toBe("object");
      expect(t.input_schema.required).toContain("reason");
      expect(JSON.stringify(t.input_schema)).not.toContain("$schema");
    }
  });
});

describe("ask_host", () => {
  it("posts the message and logs the decision", async () => {
    const { h, state } = fakeCtx();
    const r = await h.ask_host({ message: "Which sizes?", reason: "size split missing" });
    expect(r.isError).toBeFalsy();
    expect(state.posted).toEqual(["Which sizes?"]);
    expect(state.decisions).toEqual([{ tool: "ask_host", reason: "size split missing", input: { message: "Which sizes?", reason: "size split missing" }, verdict: "none", outcome: "done" }]);
  });

  it("logs and rejects a call without a reason", async () => {
    const { h, state } = fakeCtx();
    const r = await h.ask_host({ message: "Hi" });
    expect(r.isError).toBe(true);
    expect(state.posted).toEqual([]);
    expect(state.decisions[0]).toMatchObject({ tool: "ask_host", reason: "(no reason given)", outcome: "error" });
  });

  it("logs and returns error when postToHost throws", async () => {
    const state = { spec: structuredClone(EMPTY_SPEC) as OrderSpec, posted: [] as string[], decisions: [] as Omit<NewDecision, "orderId">[] };
    const ctx: ToolContext = {
      policy: DEFAULT_POLICY,
      async getSpec() { return structuredClone(state.spec); },
      async saveSpec(s) { state.spec = structuredClone(s); },
      async postToHost() { throw new Error("db down"); },
      async loadArtwork(id) { return null; },
      async logDecision(d) { state.decisions.push(d); },
    };
    const h = makeHandlers(ctx);
    const r = await h.ask_host({ message: "Hi", reason: "greeting the host" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Tool failed");
    expect(state.decisions).toHaveLength(1);
    expect(state.decisions[0]).toMatchObject({ tool: "ask_host", reason: "greeting the host", outcome: "error", detail: "db down" });
  });
});

describe("update_order", () => {
  it("saves a valid spec and reports what is missing", async () => {
    const { h, state } = fakeCtx();
    const r = await h.update_order({ spec: { items: [tee], artwork: [] }, reason: "host gave the shirt details" });
    expect(r.isError).toBeFalsy();
    expect(state.spec.items).toHaveLength(1);
    expect(r.content).toContain("Still missing: printable artwork");
    expect(state.decisions[0]).toMatchObject({ verdict: "allow", outcome: "done" });
  });

  it("does not save a spec whose sizes don't add up", async () => {
    const { h, state } = fakeCtx();
    const r = await h.update_order({ spec: { items: [{ ...tee, sizes: { S: 10 } }], artwork: [] }, reason: "sizes" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("sizes add up to 10, quantity is 60");
    expect(state.spec.items).toHaveLength(0);
    expect(state.decisions[0]).toMatchObject({ verdict: "block", outcome: "blocked" });
  });

  it("does not save a spec with a wrong method", async () => {
    const { h, state } = fakeCtx();
    const r = await h.update_order({ spec: { items: [{ kind: "sticker", description: "s", method: "screen", quantity: 50 }], artwork: [] }, reason: "stickers" });
    expect(r.isError).toBe(true);
    expect(state.spec.items).toHaveLength(0);
  });

  it("saves an item that needs approval and says so", async () => {
    const { h, state } = fakeCtx();
    const r = await h.update_order({ spec: { items: [tee, { kind: "banner", description: "2 m banner", quantity: 1 }], artwork: [] }, reason: "host also wants a banner" });
    expect(r.isError).toBeFalsy();
    expect(state.spec.items).toHaveLength(2);
    expect(r.content).toContain("needs the owner's approval");
    expect(state.decisions[0]).toMatchObject({ verdict: "escalate", outcome: "escalated" });
  });

  it("rejects artwork reviews for files that don't exist", async () => {
    const { h } = fakeCtx();
    const r = await h.update_order({ spec: { items: [tee], artwork: [{ fileId: "ghost", printable: true, issues: [] }] }, reason: "artwork" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("ghost");
  });
});

describe("check_artwork", () => {
  const png: ArtworkFile = { fileId: "f1", name: "logo.png", mediaType: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) };
  const svg: ArtworkFile = { fileId: "f2", name: "logo.svg", mediaType: "image/svg+xml", bytes: new Uint8Array(10) };
  const huge: ArtworkFile = { fileId: "f3", name: "big.png", mediaType: "image/png", bytes: new Uint8Array(3_600_000) };
  const pdf: ArtworkFile = { fileId: "f4", name: "logo.pdf", mediaType: "application/pdf", bytes: new Uint8Array([37, 80, 68, 70]) };

  it("returns images and PDFs for the model to look at", async () => {
    const { h } = fakeCtx([png, pdf]);
    const img = await h.check_artwork({ fileId: "f1", reason: "host uploaded a logo" });
    expect(img.content).toEqual([
      { type: "text", text: "logo.png (image/png, 4 bytes). Review it, then record the result with update_order." },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw==" } },
    ]);
    const doc = await h.check_artwork({ fileId: "f4", reason: "host uploaded a pdf" });
    expect((doc.content as Array<{ type: string }>)[1].type).toBe("document");
  });

  it("explains files it can't preview", async () => {
    const { h } = fakeCtx([svg, huge]);
    expect((await h.check_artwork({ fileId: "f2", reason: "svg" })).content).toMatch(/can't preview image\/svg\+xml/);
    expect((await h.check_artwork({ fileId: "f3", reason: "big" })).content).toMatch(/too large to preview/);
  });

  it("rejects check_artwork for unknown fileId", async () => {
    const { h, state } = fakeCtx();
    const missing = await h.check_artwork({ fileId: "nope", reason: "host mentioned a file" });
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain("nope");
    expect(state.decisions[0]).toMatchObject({ outcome: "error", detail: "unknown fileId" });
  });
});
