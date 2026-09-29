import { describe, expect, it } from "vitest";
import { TRANSFER_TOPIC, USDC_SYSTEM_EMITTER, addressTopic, createRpc, decodeTransfer, type RawLog } from "../src/arc";

const EURC = "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1";
const FROM = "0x2222222222222222222222222222222222222222";
const TO = "0x1111111111111111111111111111111111111111";
const log = (o: Partial<RawLog>): RawLog => ({
  address: USDC_SYSTEM_EMITTER, topics: [TRANSFER_TOPIC, addressTopic(FROM), addressTopic(TO)],
  data: "0x" + (257500042n * 10n ** 12n).toString(16).padStart(64, "0"),
  blockNumber: "0x64", transactionHash: "0x" + "ab".repeat(32), logIndex: "0x2", ...o,
});

describe("decodeTransfer", () => {
  it("reads native USDC from the system emitter in 18 decimals", () => {
    expect(decodeTransfer(log({}), EURC)).toEqual({
      txHash: "0x" + "ab".repeat(32), logIndex: 2, blockNumber: 100, token: "USDC", from: FROM, amountUnits: 257500042,
    });
  });

  it("reads EURC in 6 decimals and ignores anything else", () => {
    const eurc = log({ address: EURC.toLowerCase(), data: "0x" + (1_500_000n).toString(16).padStart(64, "0") });
    expect(decodeTransfer(eurc, EURC)).toMatchObject({ token: "EURC", amountUnits: 1_500_000 });
    expect(decodeTransfer(log({ address: "0x3600000000000000000000000000000000000000" }), EURC)).toBeNull();
    expect(decodeTransfer(log({ topics: [TRANSFER_TOPIC] }), EURC)).toBeNull();
    expect(decodeTransfer(log({ topics: ["0x" + "00".repeat(32), addressTopic(FROM), addressTopic(TO)] }), EURC)).toBeNull();
  });
});

describe("createRpc", () => {
  it("falls back to the next URL on HTTP and JSON-RPC errors", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      const { id } = JSON.parse(String(init?.body));
      if (url === "https://a") return new Response("slow down", { status: 429 });
      if (url === "https://b") return Response.json({ jsonrpc: "2.0", id, error: { code: -32005, message: "rate limit exceeded" } });
      return Response.json({ jsonrpc: "2.0", id, result: "0x1f4" });
    }) as typeof fetch;
    expect(await createRpc(["https://a", "https://b", "https://c"], fetchImpl).blockNumber()).toBe(500);
    expect(seen).toEqual(["https://a", "https://b", "https://c"]);
  });

  it("throws the last error when every URL fails", async () => {
    const fetchImpl = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    await expect(createRpc(["https://a"], fetchImpl).blockNumber()).rejects.toThrow("HTTP 503");
    await expect(createRpc([], fetchImpl).blockNumber()).rejects.toThrow("no RPC URL");
  });
});
