import { ratesFor } from "./fx";
import { isAddress } from "./money";

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** Missing configuration the owner should know about. */
export function configWarnings(env: Env): string[] {
  const warnings: string[] = [];
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_OWNER_CHAT_ID) warnings.push("Telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_OWNER_CHAT_ID).");
  if (String(env.REQUIRE_TURNSTILE) !== "0" && !env.TURNSTILE_SECRET) warnings.push("Turnstile secret is missing: new orders are refused.");
  if (!isAddress(env.RECEIVING_ADDRESS)) warnings.push("RECEIVING_ADDRESS is missing or malformed: hosts can't accept quotes.");
  return warnings;
}

/** Configuration warnings plus state the owner should know about. */
export async function adminWarnings(env: Env): Promise<string[]> {
  const warnings = configWarnings(env);
  if (!(await ratesFor(env.DB, "USD"))) warnings.push("Exchange rates are stale or missing: quotes are paused.");
  return warnings;
}
