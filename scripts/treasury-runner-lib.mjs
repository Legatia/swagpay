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
 * Payouts: send each queued payout from the agent wallet and report its result.
 * A payout whose result can't be posted stays queued at Swagpay, so the next poll sends it again under the same
 * idempotency key (README: check on testnet that Circle makes the repeat a no-op).
 */
async function drain({ api, run, cfg, log }, { path, key, label, build, describe }) {
  const res = await api(path);
  if (!res.ok) throw new Error(`${key}: HTTP ${res.status}`);
  const items = (await res.json())[key];
  for (const p of items) {
    let args;
    try {
      args = build(p, cfg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`${label} #${p.id}: rejected (${message})`);
      if (!cfg.dryRun) await api(`${path}/${p.id}/result`, { method: "POST", body: JSON.stringify({ status: "failed", error: `runner rejected the ${label}: ${message}` }) });
      continue;
    }
    if (cfg.dryRun) {
      log.info(`[dry run] ${label} #${p.id}: ${cfg.circle} ${args.join(" ")}`);
      continue;
    }
    log.info(`${label} #${p.id}: ${describe(p)}`);
    const { code, stdout, stderr } = await run(args);
    const r = classifyResult(code, stdout, stderr);
    const posted = await api(`${path}/${p.id}/result`, { method: "POST", body: JSON.stringify(r) });
    log.info(`${label} #${p.id}: ${r.status}${r.ref ? ` ${r.ref}` : ""}${r.error ? ` (${r.error})` : ""} -> HTTP ${posted.status}`);
  }
}

const FIAT = { EUR: { pair: "USDCEUR", key: "eurKey" }, GBP: { pair: "USDCGBP", key: "gbpKey" } };
const FIAT_AMOUNT = /^\d{1,9}\.\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** kraken-cli prints Kraken's `result` object with -o json (verify with the first DRY_RUN; these parsers accept either the result or a wrapper with `result`). */
const unwrap = (o) => (o && typeof o === "object" && "result" in o ? o.result : o);
export function bidOf(t) {
  const v = Object.values(unwrap(t) ?? {}).find((x) => Array.isArray(x?.b));
  const n = Number(v?.b?.[0]);
  if (!(n > 0)) throw new Error("ticker: no bid price");
  return n;
}
export const balanceOf = (b, asset) => Number(unwrap(b)?.[asset] ?? 0) || 0;
export const feeOf = (w) => Number(unwrap(w)?.fee ?? 0) || 0;
export const txidOf = (o) => { const t = unwrap(o)?.txid; return (Array.isArray(t) ? t[0] : t) ?? null; };
export const refidOf = (w) => unwrap(w)?.refid ?? null;
export function closedByClOrdId(r, id) {
  const closed = unwrap(r)?.closed ?? {};
  for (const [txid, o] of Object.entries(closed)) if (o?.cl_ord_id === id && Number(o?.vol_exec) > 0) return { txid, volExec: Number(o.vol_exec) };
  return null;
}

async function kj(kraken, args) {
  const { code, stdout, stderr } = await kraken([...args, "-o", "json"]);
  if (code !== 0) throw new Error((stderr || stdout || `kraken exited ${code}`).trim().slice(0, 300));
  try { return JSON.parse(stdout); } catch { throw new Error(`kraken ${args.slice(0, 2).join(" ")}: output is not JSON`); }
}

/**
 * One cash-out: sell just enough USDC (queued), then withdraw to the owner's saved account (sold). The sale carries the
 * cash-out's client order id and is looked up first, so a retry after a lost result never sells twice.
 */
export async function runCashout(c, { kraken, api, cfg, log, now = Date.now() }) {
  const post = (body) => api(`/api/treasury/cashouts/${c.id}/result`, { method: "POST", body: JSON.stringify(body) });
  const fiat = FIAT[c.fiat];
  const key = fiat ? cfg[fiat.key] : null;
  if (!fiat || !FIAT_AMOUNT.test(c.amount) || !UUID.test(c.clientOrderId)) {
    log.error(`cash-out #${c.id}: rejected (bad fiat, amount or client order id)`);
    if (!cfg.dryRun && c.status === "queued") await post({ status: "failed", error: "runner rejected the cash-out: bad fiat, amount or client order id" });
    return;
  }
  if (!key) {
    log.error(`cash-out #${c.id}: no withdrawal key for ${c.fiat} (set KRAKEN_${c.fiat}_KEY)`);
    return;
  }
  let status = c.status;
  if (status === "queued") {
    const done = closedByClOrdId(await kj(kraken, ["closed-orders", "--cl-ord-id", c.clientOrderId]), c.clientOrderId);
    if (done) {
      if (!cfg.dryRun) await post({ stage: "sold", orderRef: done.txid, soldUnits: done.volExec.toFixed(6) });
      status = "sold";
    } else {
      const fee = feeOf(await kj(kraken, ["withdrawal", "info", c.fiat, key, c.amount]));
      const bid = bidOf(await kj(kraken, ["ticker", fiat.pair]));
      const volume = (Math.ceil(((Number(c.amount) + fee) / bid) * 1.01 * 1e6) / 1e6).toFixed(6);
      const have = balanceOf(await kj(kraken, ["balance"]), "USDC");
      if (have < Number(volume)) {
        const why = `USDC has not arrived at Kraken (have ${have}, need ${volume})`;
        if (now - Date.parse(c.createdAt) > 2 * 3_600_000) { if (!cfg.dryRun) await post({ status: "failed", error: why }); }
        else log.info(`cash-out #${c.id}: waiting: ${why}`);
        return;
      }
      const sell = ["order", "sell", fiat.pair, volume, "--type", "market", "--cl-ord-id", c.clientOrderId];
      if (cfg.dryRun) {
        await kj(kraken, [...sell, "--validate"]);
        log.info(`[dry run] cash-out #${c.id}: would sell ${volume} USDC on ${fiat.pair} and withdraw ${c.amount} ${c.fiat} to "${key}" (fee ${fee})`);
        return;
      }
      const txid = txidOf(await kj(kraken, sell));
      await post({ stage: "sold", orderRef: txid, soldUnits: volume });
      status = "sold";
    }
  }
  if (status === "sold") {
    if (cfg.dryRun) { log.info(`[dry run] cash-out #${c.id}: would withdraw ${c.amount} ${c.fiat} to "${key}"`); return; }
    try {
      const w = await kj(kraken, ["withdraw", c.fiat, key, c.amount]);
      const info = await kj(kraken, ["withdrawal", "info", c.fiat, key, c.amount]).catch(() => null);
      await post({ stage: "withdrawn", withdrawalRef: refidOf(w), feeCents: info ? Math.round(feeOf(info) * 100) : null });
    } catch (err) {
      await post({ stage: "withdraw_error", error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/**
 * One poll: payouts from the agent wallet, then cash-outs on Kraken (only when `kraken` and a withdrawal key are configured).
 * `api(path, init)` resolves a fetch Response; `run(args)` and `kraken(args)` resolve { code, stdout, stderr }; `log` has info and error.
 */
export async function runOnce(ctx) {
  await drain(ctx, { path: "/api/treasury/payouts", key: "payouts", label: "payout", build: buildCommand, describe: (p) => `${p.amount} ${p.token} to ${p.chain} ${p.destination}` });
  if (ctx.kraken && (ctx.cfg.eurKey || ctx.cfg.gbpKey)) {
    const res = await ctx.api("/api/treasury/cashouts");
    if (!res.ok) throw new Error(`cashouts: HTTP ${res.status}`);
    for (const c of (await res.json()).cashouts) {
      try { await runCashout(c, ctx); } catch (err) { ctx.log.error(`cash-out #${c.id}: ${err instanceof Error ? err.message : String(err)}`); }
    }
  }
}
