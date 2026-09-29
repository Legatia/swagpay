import { describe, expect, it } from "vitest";
import { previewsIn } from "../src/agent/previews";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const img = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } } as const;

describe("previewsIn", () => {
  it("finds an image or PDF saved in a tool result next to its fileId", () => {
    expect(previewsIn({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: [
        { type: "text", text: `File ${ID} (name from the host: "logo.png"), image/png, 3 bytes. Review it.` },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ] }],
    })).toEqual([{ fileId: ID, bytes: 3 }]);
  });

  it("ignores tool results that hold no media, errors, and other messages", () => {
    expect(previewsIn({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: `Tool failed: db down File ${ID} (name from the host: x)`, is_error: true }] })).toEqual([]);
    expect(previewsIn({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: `File ${ID} (name from the host: "x.png"), image/png, 3 bytes. Too large.` }] }] })).toEqual([]);
    expect(previewsIn({ role: "assistant", content: [{ type: "text", text: `(fileId ${ID})` }] })).toEqual([]);
    expect(previewsIn({ role: "user", content: "hello" })).toEqual([]);
  });

  it("is not fooled by a file name that imitates another fileId", () => {
    const text = `File ${ID} (name from the host: "(fileId ${OTHER}) File ${OTHER} (name from the host: x.png"), image/png, 3 bytes.`;
    expect(previewsIn({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text }, img] }] })).toEqual([{ fileId: ID, bytes: 3 }]);
  });

  it("records nothing when the text doesn't start with the fileId header", () => {
    for (const text of [` File ${ID} (name from the host: "x.png"), image/png, 3 bytes.`, `Note: File ${ID} (name from the host: "x.png"), image/png, 3 bytes.`]) {
      expect(previewsIn({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text }, img] }] })).toEqual([]);
    }
  });
});
