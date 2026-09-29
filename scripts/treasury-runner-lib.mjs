/** Circle CLI arguments for one payout from the agent wallet. */
export function buildCommand(p, cfg) {
  // Worker-supplied values go into argv: check each one here, none may start with "-".
  if (p.method !== "transfer" && p.method !== "bridge") throw new Error(`unknown payout method ${p.method}`);
  if (typeof p.destination !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(p.destination)) throw new Error("bad destination");
  if (typeof p.chain !== "string" || !/^[A-Z0-9-]{2,24}$/.test(p.chain)) throw new Error("bad chain");
  if (p.method === "transfer" && p.chain !== cfg.chain) throw new Error(`bad chain: a transfer must be on ${cfg.chain}`);
  if (typeof p.amount !== "string" || !/^\d{1,12}\.\d{1,6}$/.test(p.amount) || !(Number(p.amount) > 0)) throw new Error("bad amount");
  if (typeof p.idempotencyKey !== "string" || !/^[0-9a-fA-F-]{8,64}$/.test(p.idempotencyKey)) throw new Error("bad idempotencyKey");
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
