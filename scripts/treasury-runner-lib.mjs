/** Circle CLI arguments for one payout from the agent wallet. */
export function buildCommand(p, cfg) {
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
      const j = JSON.parse(stdout);
      ref = j?.data?.id ?? j?.data?.transactionId ?? j?.data?.txHash ?? j?.data?.hash ?? j?.id ?? null;
    } catch {
      ref = (stdout ?? "").trim().split("\n")[0] || null;
    }
    return { status: "sent", ref: ref === null ? null : String(ref).slice(0, 200) };
  }
  if (/polic|limit|exceed|denied|budget|not allowed/i.test(text)) return { status: "denied", error: text.slice(0, 500) };
  return { status: "failed", error: text.slice(0, 500) || `exit ${code}` };
}
