import { handleTreasuryApi } from "../treasury-api";
import { bankPass, type BankCashout } from "./bank";
import { createChainClient, type ChainClient } from "./chain";
import { TESTNET_CHAIN_ID, isSandbox } from "./config";

interface QueuedPayout { id: number; method: string; chain: string; token: string; amount: string; destination: string; idempotencyKey: string }

/**
 * The sandbox's stand-in for the owner's Mac runner, inside the Worker: testnet USDC payouts through a viem wallet, cash-outs through
 * the mock bank. It talks to the same treasury API the real runner uses, so results take the production path. Does nothing outside
 * the sandbox or off Arc testnet.
 */
export async function runSandboxRunner(env: Env, deps: { chain?: ChainClient; now?: Date } = {}): Promise<void> {
  if (!isSandbox(env) || String(env.ARC_CHAIN_ID) !== TESTNET_CHAIN_ID) return;
  const now = deps.now ?? new Date();
  const auth = { authorization: `Bearer ${env.TREASURY_RUNNER_TOKEN}` };
  const call = (path: string, init: RequestInit = {}) =>
    handleTreasuryApi(new Request(`https://sandbox.internal${path}`, { ...init, headers: { ...auth, "content-type": "application/json" } }), env);

  const { payouts } = await (await call("/api/treasury/payouts")).json<{ payouts: QueuedPayout[] }>();
  let chain = deps.chain;
  for (const p of payouts) {
    const report = (body: unknown) => call(`/api/treasury/payouts/${p.id}/result`, { method: "POST", body: JSON.stringify(body) });
    if (p.method !== "transfer" || p.chain !== "ARC" || p.token !== "USDC") { await report({ status: "failed", error: "sandbox: only ARC transfers" }); continue; }
    // Before claiming the key: a missing or bad wallet key sent nothing, so nothing is left claimed.
    try { chain ??= createChainClient(env); } catch (err) { await report({ status: "failed", error: (err instanceof Error ? err.message : String(err)).slice(0, 500) }); continue; }
    const claimed = await env.DB.prepare("INSERT OR IGNORE INTO sandbox_runner_sends (idempotency_key, payout_id, created_at) VALUES (?, ?, ?)").bind(p.idempotencyKey, p.id, now.toISOString()).run();
    if (claimed.meta.changes !== 1) {
      const prior = await env.DB.prepare("SELECT tx_hash FROM sandbox_runner_sends WHERE idempotency_key = ?").bind(p.idempotencyKey).first<{ tx_hash: string | null }>();
      await report(prior?.tx_hash ? { status: "sent", ref: prior.tx_hash } : { status: "failed", error: "sandbox runner: send state unknown for this key; check the explorer" });
      continue;
    }
    try {
      const hash = await chain!.transferUsdc(p.destination, Math.round(Number(p.amount) * 1_000_000));
      await env.DB.prepare("UPDATE sandbox_runner_sends SET tx_hash = ? WHERE idempotency_key = ?").bind(hash, p.idempotencyKey).run();
      await report({ status: "sent", ref: hash });
    } catch (err) {
      await report({ status: "failed", error: `sandbox transfer failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500) });
    }
  }

  const { cashouts } = await (await call("/api/treasury/cashouts")).json<{ cashouts: BankCashout[] }>();
  for (const c of cashouts) {
    for (const r of await bankPass(env, c, now)) {
      const res = await call(`/api/treasury/cashouts/${c.id}/result`, { method: "POST", body: JSON.stringify(r) });
      if (!res.ok) break;
    }
  }
}
