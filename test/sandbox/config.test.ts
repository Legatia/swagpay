import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { isSandbox, sandboxGuard } from "../../src/sandbox/config";
import worker from "../../src/index";

const sandbox = (over: Record<string, string> = {}) => ({ ...env, SANDBOX: "1", ARC_CHAIN_ID: "5042002", TELEGRAM_BOT_TOKEN: "", ...over }) as unknown as Env;

describe("sandbox guard", () => {
  it("is off in production and needs SANDBOX=1 exactly", () => {
    expect(isSandbox(env)).toBe(false);
    expect(isSandbox(sandbox())).toBe(true);
    expect(isSandbox(sandbox({ SANDBOX: "true" }))).toBe(false);
    expect(sandboxGuard(env)).toBeNull();
    expect(sandboxGuard(sandbox())).toBeNull();
  });

  it("refuses a mainnet chain id or a Telegram token in the sandbox", async () => {
    expect(sandboxGuard(sandbox({ ARC_CHAIN_ID: "5042" }))).toBe("SANDBOX=1 needs ARC_CHAIN_ID 5042002 (Arc testnet), got 5042");
    expect(sandboxGuard(sandbox({ TELEGRAM_BOT_TOKEN: "123:abc" }))).toBe("SANDBOX=1 must not have TELEGRAM_BOT_TOKEN set");
    const res = await worker.fetch(new Request("https://sandbox.swagpay.test/api/health"), sandbox({ ARC_CHAIN_ID: "5042" }));
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("Sandbox misconfigured.");
  });
});
