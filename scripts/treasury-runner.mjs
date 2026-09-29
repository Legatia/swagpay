#!/usr/bin/env node
// Runs on the owner's machine, where `circle wallet login` holds the agent wallet session.
// Polls Swagpay for payouts the treasury agent queued, sends each from the Circle agent wallet, and reports back.
import { execFile } from "node:child_process";
import { buildCommand, classifyResult } from "./treasury-runner-lib.mjs";

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
for (const k of ["base", "token", "wallet"]) if (!cfg[k]) throw new Error(`set ${k === "base" ? "SWAGPAY_URL" : k === "token" ? "TREASURY_RUNNER_TOKEN" : "AGENT_WALLET_ADDRESS"}`);

const api = (path, init = {}) => fetch(`${cfg.base}${path}`, { ...init, headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json", ...(init.headers ?? {}) } });

function run(args) {
  return new Promise((resolve) => {
    execFile(cfg.circle, args, { timeout: 180_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr || (err && !err.code ? err.message : "")) });
    });
  });
}

async function tick() {
  const res = await api("/api/treasury/payouts");
  if (!res.ok) throw new Error(`payouts: HTTP ${res.status}`);
  const { payouts } = await res.json();
  for (const p of payouts) {
    let args;
    try {
      args = buildCommand(p, cfg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`payout #${p.id}: rejected (${message})`);
      if (!cfg.dryRun) await api(`/api/treasury/payouts/${p.id}/result`, { method: "POST", body: JSON.stringify({ status: "failed", error: `runner rejected the payout: ${message}` }) });
      continue;
    }
    if (cfg.dryRun) {
      console.log(`[dry run] payout #${p.id}: ${cfg.circle} ${args.join(" ")}`);
      continue;
    }
    console.log(`payout #${p.id}: ${p.amount} ${p.token} to ${p.chain} ${p.destination}`);
    const { code, stdout, stderr } = await run(args);
    const r = classifyResult(code, stdout, stderr);
    const posted = await api(`/api/treasury/payouts/${p.id}/result`, { method: "POST", body: JSON.stringify(r) });
    console.log(`payout #${p.id}: ${r.status}${r.ref ? ` ${r.ref}` : ""}${r.error ? ` (${r.error})` : ""} -> HTTP ${posted.status}`);
  }
}

for (;;) {
  try {
    await tick();
  } catch (err) {
    console.error("runner tick failed:", err instanceof Error ? err.message : err);
  }
  await new Promise((r) => setTimeout(r, cfg.intervalMs));
}
