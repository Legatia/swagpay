import type { BetaTextBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";

export type InboxItem = { kind: "host" | "event"; text: string };

/** Angle brackets become look-alikes so nobody can open or close our tags. */
export function sanitize(text: string): string {
  return text.replace(/</g, "‹").replace(/>/g, "›");
}

export function formatInbox(items: InboxItem[]): BetaTextBlockParam[] {
  return items.map((i) => ({
    type: "text",
    text: i.kind === "host" ? `<host_message>${sanitize(i.text)}</host_message>` : `<event>${sanitize(i.text)}</event>`,
  }));
}
