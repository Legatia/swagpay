import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCommand, classifyResult, runOnce } from "./treasury-runner-lib.mjs";

const DEST = "0x" + "d".repeat(40);
const K1 = "11111111-1111-4111-8111-111111111111";
const K2 = "22222222-2222-4222-8222-222222222222";
const WALLET = "0x" + "a".repeat(40);
const cfg = { wallet: WALLET, usdc: "0x3600000000000000000000000000000000000000", chain: "ARC" };

test("builds an Arc transfer and a CCTP bridge", () => {
  assert.deepEqual(
    buildCommand({ method: "transfer", token: "USDC", chain: "ARC", destination: DEST, amount: "1.500000", idempotencyKey: K1 }, cfg),
    ["wallet", "transfer", DEST, "--token", cfg.usdc, "--amount", "1.500000", "--address", "0x" + "a".repeat(40), "--chain", "ARC", "--idempotency-key", K1, "--output", "json"],
  );
  assert.deepEqual(
    buildCommand({ method: "bridge", token: "USDC", chain: "MATIC", destination: DEST, amount: "2.000000", idempotencyKey: K2 }, cfg),
    ["bridge", "transfer", "MATIC", DEST, "--amount", "2.000000", "--address", "0x" + "a".repeat(40), "--chain", "ARC", "--idempotency-key", K2, "--output", "json"],
  );
  const ok = { method: "transfer", token: "USDC", chain: "ARC", destination: DEST, amount: "1.500000", idempotencyKey: K1 };
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
  bad({ chain: "--" });
  bad({ token: "EURC" });
  bad({ idempotencyKey: "abcdef12" });
  assert.deepEqual(
    buildCommand({ ...ok, chain: "ARC" }, { ...cfg, chain: "ARC-TESTNET" }).slice(-6, -4),
    ["--chain", "ARC-TESTNET"],
  );
});

test("classifies CLI results", () => {
  assert.deepEqual(classifyResult(0, JSON.stringify({ data: { id: "tx-1" } }), ""), { status: "sent", ref: "tx-1" });
  assert.equal(classifyResult(0, "0xabc\n", "").status, "sent");
  assert.equal(classifyResult(1, "", "Transfer exceeds the daily spending limit").status, "denied");
  assert.equal(classifyResult(1, "", "Policy violation: recipient not allowed").status, "denied");
  for (const t of ["timeout of 30000ms exceeded", "context deadline exceeded", "HTTP 429: rate limit", "ERC20: transfer amount exceeds balance"]) assert.equal(classifyResult(1, "", t).status, "failed", t);
  assert.equal(classifyResult(1, "", "Transfer exceeds the daily limit").status, "denied");
  assert.equal(classifyResult(1, "", "Policy violation: recipient not allowed by policy").status, "denied");
  assert.deepEqual(classifyResult(0, JSON.stringify({ data: { id: "t1", state: "FAILED" } }), ""), { status: "failed", error: "circle reported state FAILED" });
  const failed = classifyResult(1, "", "RPC timeout");
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "RPC timeout");
});

/** A fake Swagpay: lists `queued`, records posted results (a recorded payout is no longer queued); `failPosts` makes result POSTs throw. */
function fakeSwagpay(queued) {
  const s = { queued, posts: [], failPosts: 0 };
  s.api = async (path, init = {}) => {
    if (path === "/api/treasury/payouts" && init.method === undefined) return Response.json({ payouts: s.queued });
    const m = /^\/api\/treasury\/payouts\/(\d+)\/result$/.exec(path);
    if (m && init.method === "POST") {
      if (s.failPosts > 0) { s.failPosts--; throw new TypeError("fetch failed"); }
      s.posts.push({ id: Number(m[1]), body: JSON.parse(init.body) });
      s.queued = s.queued.filter((p) => p.id !== Number(m[1]));
      return Response.json({ ok: true });
    }
    throw new Error(`unexpected ${init.method ?? "GET"} ${path}`);
  };
  return s;
}
const quiet = { info() {}, error() {} };
const runCfg = { ...cfg, circle: "circle", dryRun: false };
const payout = { id: 7, obligationId: 3, method: "transfer", chain: "ARC", token: "USDC", amount: "1.500000", destination: DEST, idempotencyKey: K1 };
const keyOf = (args) => args[args.indexOf("--idempotency-key") + 1];

test("a payout whose result was lost is sent again with the same idempotency key", async () => {
  const swagpay = fakeSwagpay([payout]);
  const runs = [];
  const run = async (args) => { runs.push(args); return { code: 0, stdout: JSON.stringify({ data: { id: "tx-1" } }), stderr: "" }; };
  swagpay.failPosts = 1;
  await assert.rejects(runOnce({ api: swagpay.api, run, cfg: runCfg, log: quiet }), /fetch failed/);
  assert.equal(runs.length, 1);
  assert.deepEqual(swagpay.posts, []);
  // Next poll: still queued, so it is sent again, under the same key, and this time the result lands.
  await runOnce({ api: swagpay.api, run, cfg: runCfg, log: quiet });
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map(keyOf), [K1, K1]);
  assert.deepEqual(runs[1], runs[0]);
  assert.deepEqual(swagpay.posts, [{ id: 7, body: { status: "sent", ref: "tx-1" } }]);
  await runOnce({ api: swagpay.api, run, cfg: runCfg, log: quiet });
  assert.equal(runs.length, 2);
});

test("a payout the runner rejects is never run and is reported failed", async () => {
  const swagpay = fakeSwagpay([{ ...payout, id: 8, destination: "--rpc-url=http://evil" }]);
  let ran = false;
  await runOnce({ api: swagpay.api, run: async () => { ran = true; return { code: 0, stdout: "", stderr: "" }; }, cfg: runCfg, log: quiet });
  assert.equal(ran, false);
  assert.deepEqual(swagpay.posts, [{ id: 8, body: { status: "failed", error: "runner rejected the payout: bad destination" } }]);
});

test("a dry run neither runs nor reports", async () => {
  const swagpay = fakeSwagpay([payout]);
  const lines = [];
  let ran = false;
  await runOnce({ api: swagpay.api, run: async () => { ran = true; return { code: 0, stdout: "", stderr: "" }; }, cfg: { ...runCfg, dryRun: true }, log: { info: (m) => lines.push(m), error: (m) => lines.push(m) } });
  assert.equal(ran, false);
  assert.deepEqual(swagpay.posts, []);
  assert.match(lines.join("\n"), /\[dry run\] payout #7: circle wallet transfer /);
});
