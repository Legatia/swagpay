#!/usr/bin/env node
// Runs on the owner's machine, where `circle wallet login` holds the agent wallet session.
// Polls Swagpay for payouts the treasury agent queued, sends each from the Circle agent wallet, and reports back.
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
  dryRun: process.env.DRY_RUN === "1",
};
if (!Number.isFinite(cfg.intervalMs) || cfg.intervalMs < 1000) throw new Error("INTERVAL_MS must be at least 1000");
for (const k of ["base", "token", "wallet"]) if (!cfg[k]) throw new Error(`set ${k === "base" ? "SWAGPAY_URL" : k === "token" ? "TREASURY_RUNNER_TOKEN" : "AGENT_WALLET_ADDRESS"}`);

const api = (path, init = {}) => fetch(`${cfg.base}${path}`, { ...init, headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json", ...(init.headers ?? {}) } });

const childEnv = { ...process.env };
delete childEnv.TREASURY_RUNNER_TOKEN;

function run(args) {
  return new Promise((resolve) => {
    execFile(cfg.circle, args, { timeout: 180_000, maxBuffer: 1 << 20, env: childEnv }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr || (err && !err.code ? err.message : "")) });
    });
  });
}

const log = { info: (m) => console.log(m), error: (m) => console.error(m) };

for (;;) {
  try {
    await runOnce({ api, run, cfg, log });
  } catch (err) {
    console.error("runner tick failed:", err instanceof Error ? err.message : err);
  }
  await new Promise((r) => setTimeout(r, cfg.intervalMs));
}
