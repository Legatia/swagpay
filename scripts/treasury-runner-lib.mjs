/** Circle CLI arguments for one payout from the agent wallet. */
export function buildCommand(p, cfg) {
  // Worker-supplied values go into argv: check each one here, none may start with "-".
  if (p.method !== "transfer" && p.method !== "bridge") throw new Error(`unknown payout method ${p.method}`);
  if (typeof p.destination !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(p.destination)) throw new Error("bad destination");
  if (typeof p.chain !== "string" || !/^[A-Z][A-Z0-9-]{1,23}$/.test(p.chain)) throw new Error("bad chain");
  if (p.method === "transfer" && p.chain !== "ARC") throw new Error("bad chain: a transfer is on ARC");
  if (p.token !== "USDC") throw new Error("bad token");
  if (typeof p.amount !== "string" || !/^\d{1,12}\.\d{1,6}$/.test(p.amount) || !(Number(p.amount) > 0)) throw new Error("bad amount");
  if (typeof p.idempotencyKey !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.idempotencyKey)) throw new Error("bad idempotencyKey");
  const common = ["--amount", p.amount, "--address", cfg.wallet, "--chain", cfg.chain, "--idempotency-key", p.idempotencyKey, "--output", "json"];
  if (p.method === "transfer") return ["wallet", "transfer", p.destination, "--token", cfg.usdc, ...common];
  if (p.method === "bridge") return ["bridge", "transfer", p.chain, p.destination, ...common];
  throw new Error(`unknown payout method ${p.method}`);
}

/** sent (with Circle's transaction id or hash), denied (a spending policy said no) or failed. */
export function classifyResult(code, stdout, stderr) {
  const text = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
  if (code === 0) {
    let ref = null;
    try {
      const st = (() => { const j = JSON.parse(stdout); return String(j?.data?.state ?? j?.state ?? "").toUpperCase(); })();
      if (["FAILED", "DENIED", "CANCELLED", "REJECTED"].includes(st)) return { status: "failed", error: `circle reported state ${st}` };
    } catch {}
    try {
      const j = JSON.parse(stdout);
      ref = j?.data?.id ?? j?.data?.transactionId ?? j?.data?.txHash ?? j?.data?.hash ?? j?.id ?? null;
    } catch {
      ref = (stdout ?? "").trim().split("\n")[0] || null;
    }
    return { status: "sent", ref: ref === null ? null : String(ref).slice(0, 200) };
  }
  if (/time(d)?\s?out|deadline|rate.?limit|\b429\b|ECONN|ETIMEDOUT|network|socket/i.test(text)) return { status: "failed", error: text.slice(0, 500) };
  if (/spending (limit|policy)|polic(y|ies) (denied|violation|violated)|not allowed by (the )?polic|exceeds? (the )?(per[- ]?tx|daily|weekly|monthly) limit/i.test(text)) return { status: "denied", error: text.slice(0, 500) };
  return { status: "failed", error: text.slice(0, 500) || `exit ${code}` };
}

/**
 * One poll: send each queued payout from the agent wallet and report its result.
 * A payout whose result can't be posted stays queued at Swagpay, so the next poll sends it again under the same
 * idempotency key (README: check on testnet that Circle makes the repeat a no-op).
 * `api(path, init)` resolves a fetch Response; `run(args)` resolves { code, stdout, stderr }; `log` has info and error.
 */
export async function runOnce({ api, run, cfg, log }) {
  const res = await api("/api/treasury/payouts");
  if (!res.ok) throw new Error(`payouts: HTTP ${res.status}`);
  const { payouts } = await res.json();
  for (const p of payouts) {
    let args;
    try {
      args = buildCommand(p, cfg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`payout #${p.id}: rejected (${message})`);
      if (!cfg.dryRun) await api(`/api/treasury/payouts/${p.id}/result`, { method: "POST", body: JSON.stringify({ status: "failed", error: `runner rejected the payout: ${message}` }) });
      continue;
    }
    if (cfg.dryRun) {
      log.info(`[dry run] payout #${p.id}: ${cfg.circle} ${args.join(" ")}`);
      continue;
    }
    log.info(`payout #${p.id}: ${p.amount} ${p.token} to ${p.chain} ${p.destination}`);
    const { code, stdout, stderr } = await run(args);
    const r = classifyResult(code, stdout, stderr);
    const posted = await api(`/api/treasury/payouts/${p.id}/result`, { method: "POST", body: JSON.stringify(r) });
    log.info(`payout #${p.id}: ${r.status}${r.ref ? ` ${r.ref}` : ""}${r.error ? ` (${r.error})` : ""} -> HTTP ${posted.status}`);
  }
}
