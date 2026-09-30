import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createChainClient } from "../../src/sandbox/chain";

const key = `0x${"1".repeat(64)}`;
const cfg = (o: Record<string, string>) => ({ ...env, ARC_CHAIN_ID: "5042002", SANDBOX_WALLET_KEY: key, ...o }) as unknown as Env;

describe("createChainClient guards", () => {
  it("refuses mainnet and bad keys, and builds a client for a good key without calling the RPC", () => {
    expect(() => createChainClient(cfg({ ARC_CHAIN_ID: "5042" }))).toThrow("ARC_CHAIN_ID");
    expect(() => createChainClient(cfg({ SANDBOX_WALLET_KEY: "" }))).toThrow("SANDBOX_WALLET_KEY is not set");
    expect(() => createChainClient(cfg({ SANDBOX_WALLET_KEY: "0x1234" }))).toThrow("32-byte");
    expect(createChainClient(cfg({})).address()).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
