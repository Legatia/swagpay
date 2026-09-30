export const TESTNET_CHAIN_ID = "5042002";

/** The sandbox deployment (sandbox.swagpay.me): testnet money, simulated printers, judges as owners. */
export function isSandbox(env: Env): boolean {
  return (env as unknown as { SANDBOX?: string }).SANDBOX === "1";
}

/** Why a sandbox deployment must not run, or null. Production (SANDBOX unset) always passes. */
export function sandboxGuard(env: Env): string | null {
  if (!isSandbox(env)) return null;
  if (String(env.ARC_CHAIN_ID) !== TESTNET_CHAIN_ID) return `SANDBOX=1 needs ARC_CHAIN_ID ${TESTNET_CHAIN_ID} (Arc testnet), got ${env.ARC_CHAIN_ID}`;
  if (env.TELEGRAM_BOT_TOKEN) return "SANDBOX=1 must not have TELEGRAM_BOT_TOKEN set";
  return null;
}
