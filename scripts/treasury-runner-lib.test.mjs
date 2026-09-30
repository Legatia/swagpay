import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCommand, classifyResult, runOnce, runCashout, bidOf, balanceOf, closedByClOrdId } from "./treasury-runner-lib.mjs";

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

/** A fake Swagpay: lists `queued` payouts and `cashouts`, records posted results (a recorded payout is no longer queued); `failPosts` makes result POSTs throw. */
function fakeSwagpay(queued, swaps = [], cashouts = []) {
  const s = { queued, swaps, cashouts, posts: [], cashoutPosts: [], failPosts: 0, cashoutStatus: {}, failCashoutPosts: {} };
  s.api = async (path, init = {}) => {
    if (path === "/api/treasury/payouts" && init.method === undefined) return Response.json({ payouts: s.queued });
    if (path === "/api/treasury/cashouts" && init.method === undefined) return Response.json({ cashouts: s.cashouts });
    const m = /^\/api\/treasury\/payouts\/(\d+)\/result$/.exec(path);
    if (m && init.method === "POST") {
      if (s.failPosts > 0) { s.failPosts--; throw new TypeError("fetch failed"); }
      s.posts.push({ id: Number(m[1]), body: JSON.parse(init.body) });
      s.queued = s.queued.filter((p) => p.id !== Number(m[1]));
      return Response.json({ ok: true });
    }
    const c = /^\/api\/treasury\/cashouts\/(\d+)\/result$/.exec(path);
    if (c && init.method === "POST") {
      const id = Number(c[1]);
      const body = JSON.parse(init.body);
      const key = body.stage ?? body.status;
      if (s.failCashoutPosts[key]) throw new TypeError("fetch failed");
      s.cashoutPosts.push({ id, body });
      if (s.cashoutStatus[key]) return Response.json({ error: "x" }, { status: s.cashoutStatus[key] });
      if (body.stage === "sold") s.cashouts = s.cashouts.map((x) => (x.id === id ? { ...x, status: "sold" } : x));
      else if (body.stage === "withdrawn" || body.status === "failed") s.cashouts = s.cashouts.filter((x) => x.id !== id);
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

const K3 = "33333333-3333-4333-8333-333333333333";
const cashout = { id: 5, fiat: "EUR", amount: "237.21", clientOrderId: K3, status: "queued", createdAt: new Date().toISOString() };
const kcfg = { ...runCfg, eurKey: "My EUR account", gbpKey: null };

/** A fake kraken-cli: `answers` maps a command prefix to [code, json]. */
function fakeKraken(answers) {
  const k = { calls: [] };
  k.run = async (args) => {
    const line = args.filter((a) => a !== "-o" && a !== "json").join(" ");
    k.calls.push(line);
    const hit = Object.entries(answers).find(([prefix]) => line.startsWith(prefix));
    if (!hit) return { code: 1, stdout: "", stderr: `unexpected kraken ${line}` };
    const [code, out] = typeof hit[1] === "function" ? hit[1](line) : hit[1];
    return { code, stdout: JSON.stringify(out), stderr: code ? "kraken error" : "" };
  };
  return k;
}
const market = {
  "closed-orders": [0, { closed: {} }],
  "withdrawal info EUR": [0, { method: "SEPA", limit: "10000", fee: "1.00" }],
  "ticker USDCEUR": [0, { USDCEUR: { a: ["0.8812", "1", "1"], b: ["0.8810", "1", "1"] } }],
  "balance": [0, { USDC: "300.000000", ZEUR: "0.0000" }],
  "order sell USDCEUR": [0, { txid: ["OTX-1"], descr: { order: "sell" } }],
  "withdraw EUR": [0, { refid: "WREF-1" }],
};

test("a cash-out sells just enough USDC with its client order id, then withdraws to the saved account", async () => {
  const swagpay = fakeSwagpay([], [], [cashout]);
  const k = fakeKraken(market);
  await runCashout(cashout, { kraken: k.run, api: swagpay.api, cfg: kcfg, log: quiet });
  // (237.21 + 1.00) / 0.8810 x 1.01 = 273.0897..., rounded up to 6 decimals
  const sell = k.calls.find((c) => c.startsWith("order sell"));
  assert.equal(sell, `order sell USDCEUR 273.089785 --type market --cl-ord-id ${K3}`);
  assert.ok(k.calls.includes('withdraw EUR My EUR account 237.21'));
  assert.deepEqual(swagpay.cashoutPosts, [
    { id: 5, body: { stage: "sold", orderRef: "OTX-1", soldUnits: "273.089785" } },
    { id: 5, body: { stage: "withdrawn", withdrawalRef: "WREF-1", feeCents: 100 } },
  ]);
});

test("a retry after a lost 'sold' result finds the order by client order id and never sells twice", async () => {
  const swagpay = fakeSwagpay([], [], [cashout]);
  const k = fakeKraken({ ...market, "closed-orders": [0, { closed: { "OTX-9": { cl_ord_id: K3, status: "closed", vol_exec: "273.089785" } } }] });
  await runCashout(cashout, { kraken: k.run, api: swagpay.api, cfg: kcfg, log: quiet });
  assert.equal(k.calls.some((c) => c.startsWith("order sell")), false);
  assert.deepEqual(swagpay.cashoutPosts[0], { id: 5, body: { stage: "sold", orderRef: "OTX-9", soldUnits: "273.089785" } });
});

test("waits for the USDC, then gives up after two hours", async () => {
  const short = { ...market, balance: [0, { USDC: "10.0" }] };
  const fresh = fakeSwagpay([], [], [cashout]);
  await runCashout(cashout, { kraken: fakeKraken(short).run, api: fresh.api, cfg: kcfg, log: quiet });
  assert.deepEqual(fresh.cashoutPosts, []);
  const old = { ...cashout, createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString() };
  const late = fakeSwagpay([], [], [old]);
  await runCashout(old, { kraken: fakeKraken(short).run, api: late.api, cfg: kcfg, log: quiet });
  assert.equal(late.cashoutPosts[0].body.status, "failed");
  assert.match(late.cashoutPosts[0].body.error, /^USDC has not arrived at Kraken/);
});

test("a sold cash-out only withdraws; a withdrawal error is reported for the Worker to count", async () => {
  const sold = { ...cashout, status: "sold" };
  const swagpay = fakeSwagpay([], [], [sold]);
  const k = fakeKraken({ ...market, "withdraw EUR": [1, { error: ["EFunding:Unknown withdraw key"] }] });
  await runCashout(sold, { kraken: k.run, api: swagpay.api, cfg: kcfg, log: quiet });
  assert.equal(k.calls.some((c) => c.startsWith("order sell") || c.startsWith("closed-orders")), false);
  assert.equal(swagpay.cashoutPosts[0].body.stage, "withdraw_error");
});

test("a dry run validates the sale and moves nothing", async () => {
  const swagpay = fakeSwagpay([], [], [cashout]);
  const k = fakeKraken({ ...market, "order sell USDCEUR": [0, { descr: { order: "sell (validate)" } }] });
  await runCashout(cashout, { kraken: k.run, api: swagpay.api, cfg: { ...kcfg, dryRun: true }, log: quiet });
  assert.ok(k.calls.some((c) => c.startsWith("order sell") && c.endsWith("--validate")));
  assert.equal(k.calls.some((c) => c.startsWith("withdraw ")), false);
  assert.deepEqual(swagpay.cashoutPosts, []);
});

test("runOnce skips cash-outs without kraken, and runs them with it", async () => {
  const a = fakeSwagpay([], [], [cashout]);
  await runOnce({ api: a.api, run: async () => ({ code: 0, stdout: "", stderr: "" }), cfg: kcfg, log: quiet });
  assert.deepEqual(a.cashoutPosts, []);
  const b = fakeSwagpay([], [], [cashout]);
  await runOnce({ api: b.api, run: async () => ({ code: 0, stdout: "", stderr: "" }), kraken: fakeKraken(market).run, cfg: kcfg, log: quiet });
  assert.equal(b.cashoutPosts.length, 2);
});

test("parses kraken-cli JSON defensively", () => {
  assert.equal(bidOf({ XXUSDCZEUR: { b: ["0.9", "1", "1"] } }), 0.9);
  assert.throws(() => bidOf({}));
  assert.equal(balanceOf({ USDC: "12.5" }, "USDC"), 12.5);
  assert.equal(balanceOf({}, "USDC"), 0);
  assert.equal(closedByClOrdId({ closed: { A: { cl_ord_id: "x", vol_exec: "0" } } }, "x"), null);
});

test("a sold result the Worker did not record (500 or 409) stops the pass before any withdrawal", async () => {
  for (const status of [500, 409]) {
    const swagpay = fakeSwagpay([], [], [cashout]);
    swagpay.cashoutStatus.sold = status;
    const k = fakeKraken(market);
    await assert.rejects(runCashout(cashout, { kraken: k.run, api: swagpay.api, cfg: kcfg, log: quiet }), new RegExp(`sold result not recorded \\(HTTP ${status}\\)`));
    assert.equal(k.calls.some((c) => c.startsWith("withdraw ")), false);
    assert.equal(swagpay.cashoutPosts.length, 1);
  }
});

test("a withdrawn result that is lost is logged, never reported as a withdrawal error", async () => {
  for (const mode of ["failCashoutPosts", "cashoutStatus"]) {
    const sold = { ...cashout, status: "sold" };
    const swagpay = fakeSwagpay([], [], [sold]);
    swagpay[mode].withdrawn = mode === "failCashoutPosts" ? true : 500;
    const lines = [];
    const k = fakeKraken(market);
    await runCashout(sold, { kraken: k.run, api: swagpay.api, cfg: kcfg, log: { info() {}, error: (m) => lines.push(m) } });
    assert.ok(k.calls.includes("withdraw EUR My EUR account 237.21"));
    assert.equal(swagpay.cashoutPosts.some((p) => p.body.stage === "withdraw_error"), false);
    assert.match(lines.join("\n"), /cash-out #5: withdrawn but not recorded/);
  }
});

test("a failed or withdraw_error result that is not recorded throws", async () => {
  const old = { ...cashout, createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString() };
  const a = fakeSwagpay([], [], [old]);
  a.cashoutStatus.failed = 500;
  await assert.rejects(runCashout(old, { kraken: fakeKraken({ ...market, balance: [0, { USDC: "1" }] }).run, api: a.api, cfg: kcfg, log: quiet }), /failed result not recorded \(HTTP 500\)/);
  const sold = { ...cashout, status: "sold" };
  const b = fakeSwagpay([], [], [sold]);
  b.cashoutStatus.withdraw_error = 401;
  await assert.rejects(runCashout(sold, { kraken: fakeKraken({ ...market, "withdraw EUR": [1, {}] }).run, api: b.api, cfg: kcfg, log: quiet }), /withdraw_error result not recorded \(HTTP 401\)/);
});
