#!/usr/bin/env node
// Runs on the owner's machine, where `circle wallet login` holds the agent wallet session.
// Polls Swagpay for payouts the treasury agent queued, sends each from the Circle agent wallet, and reports back,
// and sells USDC on Kraken for the owner's printer payments (cash-outs), withdrawing to the owner's own account.
import { execFile } from "node:child_process";
import { runOnce } from "./treasury-runner-lib.mjs";

const cfg = {
  base: process.env.SWAGPAY_URL,
  token: process.env.TREASURY_RUNNER_TOKEN,
  wallet: process.env.AGENT_WALLET_ADDRESS,
  usdc: process.env.USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000",
  chain: process.env.CIRCLE_CHAIN ?? "ARC",
  circle: process.env.CIRCLE_BIN ?? "circle",
  intervalMs: Number(process.env.INTERVAL_MS ?? 30_000),
  eurKey: process.env.KRAKEN_EUR_KEY ?? null,
  gbpKey: process.env.KRAKEN_GBP_KEY ?? null,
  krakenBin: process.env.KRAKEN_BIN ?? "kraken",
  dryRun: process.env.DRY_RUN === "1",
};
if (!Number.isFinite(cfg.intervalMs) || cfg.intervalMs < 1000) throw new Error("INTERVAL_MS must be at least 1000");
for (const k of ["base", "token", "wallet"]) if (!cfg[k]) throw new Error(`set ${k === "base" ? "SWAGPAY_URL" : k === "token" ? "TREASURY_RUNNER_TOKEN" : "AGENT_WALLET_ADDRESS"}`);

const api = (path, init = {}) => fetch(`${cfg.base}${path}`, { ...init, headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json", ...(init.headers ?? {}) } });

const childEnv = { ...process.env };
delete childEnv.TREASURY_RUNNER_TOKEN;

const runner = (bin) => (args) => {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: bin === cfg.krakenBin ? 60_000 : 180_000, maxBuffer: 1 << 20, env: childEnv }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr || (err && !err.code ? err.message : "")) });
    });
  });
};
const run = runner(cfg.circle);
const kraken = runner(cfg.krakenBin);

const log = { info: (m) => console.log(m), error: (m) => console.error(m) };

// Cash-outs withdrawn but not recorded by the Worker, so a later poll reports them instead of withdrawing again.
const unrecorded = new Map();

for (;;) {
  try {
    await runOnce({ api, run, kraken, cfg, log, unrecorded });
  } catch (err) {
    console.error("runner tick failed:", err instanceof Error ? err.message : err);
  }
  await new Promise((r) => setTimeout(r, cfg.intervalMs));
}
