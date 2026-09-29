import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCommand, classifyResult } from "./treasury-runner-lib.mjs";

const DEST = "0x" + "d".repeat(40);
const K1 = "11111111-1111-4111-8111-111111111111";
const K2 = "22222222-2222-4222-8222-222222222222";
const WALLET = "0x" + "a".repeat(40);
const cfg = { wallet: WALLET, usdc: "0x3600000000000000000000000000000000000000", chain: "ARC" };

test("builds an Arc transfer and a CCTP bridge", () => {
  assert.deepEqual(
    buildCommand({ method: "transfer", chain: "ARC", destination: DEST, amount: "1.500000", idempotencyKey: K1 }, cfg),
    ["wallet", "transfer", DEST, "--token", cfg.usdc, "--amount", "1.500000", "--address", "0x" + "a".repeat(40), "--chain", "ARC", "--idempotency-key", K1, "--output", "json"],
  );
  assert.deepEqual(
    buildCommand({ method: "bridge", chain: "MATIC", destination: DEST, amount: "2.000000", idempotencyKey: K2 }, cfg),
    ["bridge", "transfer", "MATIC", DEST, "--amount", "2.000000", "--address", "0x" + "a".repeat(40), "--chain", "ARC", "--idempotency-key", K2, "--output", "json"],
  );
  const ok = { method: "transfer", chain: "ARC", destination: DEST, amount: "1.500000", idempotencyKey: K1 };
  const bad = (over) => assert.throws(() => buildCommand({ ...ok, ...over }, cfg));
  bad({ method: "swap" });
  bad({ destination: "--rpc-url=http://evil" });
  bad({ destination: "0x123" });
  bad({ chain: "arc b" });
  bad({ amount: "-1" });
  bad({ amount: "1e9" });
  bad({ amount: "0.000000" });
  bad({ idempotencyKey: "--quiet" });
  bad({ chain: "MATIC" });
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
