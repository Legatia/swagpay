import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";

const FILE_ID = /^File ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) \(name from the host: /;

type Loose = { type?: string; text?: string; content?: unknown; source?: { type?: string; data?: string } };

/** Artwork previews a message really holds: a tool_result with an image or PDF next to a text naming its fileId. */
export function previewsIn(message: BetaMessageParam): { fileId: string; bytes: number }[] {
  if (message.role !== "user" || !Array.isArray(message.content)) return [];
  const found: { fileId: string; bytes: number }[] = [];
  for (const block of message.content as Loose[]) {
    if (block.type !== "tool_result" || !Array.isArray(block.content)) continue;
    const parts = block.content as Loose[];
    const media = parts.find((p) => (p.type === "image" || p.type === "document") && p.source?.type === "base64" && typeof p.source.data === "string");
    const fileId = parts.find((p) => p.type === "text" && typeof p.text === "string" && FILE_ID.test(p.text))?.text?.match(FILE_ID)?.[1];
    const data = media?.source?.data;
    if (data && fileId) {
      const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
      found.push({ fileId, bytes: (data.length * 3) / 4 - padding });
    }
  }
  return found;
}
