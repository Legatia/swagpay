import { describe, expect, it } from "vitest";
import { previewsIn } from "../src/agent/previews";

const ID = "11111111-1111-4111-8111-111111111111";

describe("previewsIn", () => {
  it("finds an image or PDF saved in a tool result next to its fileId", () => {
    expect(previewsIn({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: [
        { type: "text", text: `File (from the host): "logo.png" (fileId ${ID}), image/png, 3 bytes. Review it.` },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ] }],
    })).toEqual([{ fileId: ID, bytes: 3 }]);
  });

  it("ignores tool results that hold no media, errors, and other messages", () => {
    expect(previewsIn({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: `Tool failed: db down (fileId ${ID})`, is_error: true }] })).toEqual([]);
    expect(previewsIn({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: `(fileId ${ID}) too large` }] }] })).toEqual([]);
    expect(previewsIn({ role: "assistant", content: [{ type: "text", text: `(fileId ${ID})` }] })).toEqual([]);
    expect(previewsIn({ role: "user", content: "hello" })).toEqual([]);
  });
});
