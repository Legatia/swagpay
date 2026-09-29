import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCommand, classifyResult } from "./treasury-runner-lib.mjs";

const cfg = { wallet: "0xWALLET", usdc: "0x3600000000000000000000000000000000000000", chain: "ARC" };

test("builds an Arc transfer and a CCTP bridge", () => {
  assert.deepEqual(
    buildCommand({ method: "transfer", chain: "ARC", destination: "0xDEST", amount: "1.500000", idempotencyKey: "k1" }, cfg),
    ["wallet", "transfer", "0xDEST", "--token", cfg.usdc, "--amount", "1.500000", "--address", "0xWALLET", "--chain", "ARC", "--idempotency-key", "k1", "--output", "json"],
  );
  assert.deepEqual(
    buildCommand({ method: "bridge", chain: "MATIC", destination: "0xDEST", amount: "2.000000", idempotencyKey: "k2" }, cfg),
    ["bridge", "transfer", "MATIC", "0xDEST", "--amount", "2.000000", "--address", "0xWALLET", "--chain", "ARC", "--idempotency-key", "k2", "--output", "json"],
  );
  assert.throws(() => buildCommand({ method: "swap", chain: "ARC", destination: "0x", amount: "1", idempotencyKey: "k" }, cfg));
});

test("classifies CLI results", () => {
  assert.deepEqual(classifyResult(0, JSON.stringify({ data: { id: "tx-1" } }), ""), { status: "sent", ref: "tx-1" });
  assert.equal(classifyResult(0, "0xabc\n", "").status, "sent");
  assert.equal(classifyResult(1, "", "Transfer exceeds the daily spending limit").status, "denied");
  assert.equal(classifyResult(1, "", "Policy violation: recipient not allowed").status, "denied");
  const failed = classifyResult(1, "", "RPC timeout");
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "RPC timeout");
});
