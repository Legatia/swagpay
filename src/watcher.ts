import { getAgentByName } from "agents";
import { TRANSFER_TOPIC, USDC_SYSTEM_EMITTER, addressTopic, decodeTransfer, type RpcClient } from "./arc";
import { getOrderById, setOrderStatus } from "./db";
import { createEscalation } from "./escalations";
import { formatCents, formatUnits, isAddress } from "./money";
import { applyClaims, depositPaid, getPaymentRequest, listUnnotified, markNotified, recordTransfer, type NewTransfer, type PaymentRequestRow, type TransferOutcome, type TransferRow } from "./payments";
import { loadPolicy } from "./policy";
import { warsawTime } from "./quote-text";
import { getQuote } from "./quotes";
import { createTelegram, notifyOwner, type TelegramClient } from "./telegram";
import { createObligation, loadTreasuryPolicy, printerCostUnits } from "./treasury";

export const CHUNK_BLOCKS = 5000;
export const MAX_CHUNKS_PER_RUN = 20;
/** Stay this many blocks behind the head (about 19 seconds on Arc) so a lagging node cannot skip a log we then mark processed. */
export const HEAD_LAG_BLOCKS = 30;
/** Unmatched transfers below 1 USDC/EURC are logged, not escalated. */
export const MIN_ESCALATION_UNITS = 1_000_000;

async function getState(db: D1Database, key: string): Promise<string | null> {
  return (await db.prepare("SELECT value FROM watcher_state WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;
}

async function setState(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare("INSERT OR REPLACE INTO watcher_state (key, value) VALUES (?, ?)").bind(key, value).run();
}

async function clearState(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM watcher_state WHERE key = ?").bind(key).run();
}

/** One system escalation per alert key until the key is cleared (when the problem goes away). */
async function alertOnce(env: Env, telegram: TelegramClient, key: string, summary: string): Promise<void> {
  if ((await getState(env.DB, key)) !== null) return;
  const e = await createEscalation(env.DB, { orderId: null, kind: "system", summary, payload: { watcher: key } });
  await setState(env.DB, key, String(e.id));
  await notifyOwner(env.DB, telegram, env.TELEGRAM_OWNER_CHAT_ID, e);
}

/** A run starts no new chunk after this much wall-clock time, well inside the cron's limits and the lock's lease. */
export const RUN_BUDGET_MS = 120_000;
/** A cursor this far past the chain head belongs to another chain or database. */
export const MAX_CURSOR_AHEAD_BLOCKS = 1000;

/** Tells the order's agent (and the host's thread) about a credited transfer; escalates overpayment. Reports the request as it stood when this transfer was credited. */
async function onMatched(env: Env, telegram: TelegramClient, o: { transfer: TransferRow; request: PaymentRequestRow; via: "amount" | "claim" }): Promise<void> {
  const r = o.request;
  const t = o.transfer;
  const order = await getOrderById(env.DB, r.order_id);
  if (!order) return;
  const paid = t.paid_after ?? r.paid_units;
  const got = `${formatUnits(t.amount_units)} ${r.token}`;
  let text = `Payment received on Arc: ${got} for ${r.stage} request #${r.id} (tx ${t.tx_hash}). Paid ${formatUnits(paid)} of ${formatUnits(r.amount_units)}.`;
  if (paid < r.amount_units) text += ` Still due: ${formatUnits(r.amount_units - paid)} ${r.token}.`;
  let completedDeposit = false;
  // Late means this transfer reached Swagpay after the request's due time; it is still credited.
  const late = Date.parse(t.created_at) > Date.parse(r.due_by);
  // This transfer completed its request (it was not complete before it).
  const completed = paid - t.amount_units < r.amount_units && paid >= r.amount_units;
  if (r.stage === "deposit" && (await depositPaid(env.DB, order.id))) {
    // "quoted" too: if the accept route could not move the order to deposit_pending, the deposit still completes it. Idempotent.
    await setOrderStatus(env.DB, order.id, ["quoted", "deposit_pending"], "deposit_paid");
    if (completed) {
      completedDeposit = true;
      text += late
        ? " The deposit arrived after it was due; the owner will confirm whether printing is still possible before anything is booked."
        : " The deposit is fully paid.";
    }
  }
  let completedBalance = false;
  if (r.stage === "balance" && completed) {
    await setOrderStatus(env.DB, order.id, ["deposit_paid", "balance_pending"], "balance_paid");
    completedBalance = true;
    text += ' The balance is fully paid. When the swag arrives, ask the host to press "We received it" on the order page.';
  }
  const surplus = paid > r.amount_units ? Math.min(t.amount_units, paid - r.amount_units) : 0;
  if (surplus > 0) text += ` Overpaid by ${formatUnits(surplus)} ${r.token}; the owner will refund it.`;
  // Bad treasury config must throw before any side effect, so a retry never repeats the agent event or owner pings.
  const quote = completedDeposit ? await getQuote(env.DB, r.quote_id) : null;
  const treasury = quote ? loadTreasuryPolicy(env as unknown as Record<string, unknown>) : null;
  const fxBuffer = quote ? loadPolicy(env as unknown as Record<string, unknown>).fxBuffer : 0;
  const agent = await getAgentByName(env.OrderAgent, order.instance);
  await agent.pushEvent(text, `Payment received: ${got}.`);
  // Owner escalations come last, so a failing agent call cannot repeat owner pings on every retry.
  if (surplus > 0) {
    const refund = await createObligation(env.DB, {
      orderId: order.id, kind: "refund", token: r.token, amountUnits: surplus, destination: t.from_address, chain: "ARC",
      dueAt: new Date(), sourceRef: `refund:${t.tx_hash}:${t.log_index}`, status: "escalated",
    });
    const e = await createEscalation(env.DB, {
      orderId: order.id, kind: "approval",
      summary: `Order ${order.id} overpaid by ${formatUnits(surplus)} ${r.token} (tx ${t.tx_hash}). Refund it to ${t.from_address}? ${r.token === "USDC" ? `Approve to let the treasury agent send it (refund obligation #${refund.id}); reject if you'll handle it yourself.` : `The treasury agent only sends USDC: approve once you've refunded it by hand from the wallet, or reject (refund obligation #${refund.id}).`} Exchanges and bridges send from shared addresses: check with the payer first.`,
      payload: { txHash: t.tx_hash, logIndex: t.log_index, surplus, obligationId: refund.id },
    });
    await notifyOwner(env.DB, telegram, env.TELEGRAM_OWNER_CHAT_ID, e);
  }
  if (o.via === "claim") {
    // Anyone can paste a public tx hash; the amount matched nothing, so the owner checks it really came from this payer.
    const e = await createEscalation(env.DB, {
      orderId: order.id, kind: "payment",
      summary: `Order ${order.id}: ${got} (tx ${t.tx_hash}) was credited to ${r.stage} request #${r.id} because the payer pasted its hash; the amount matched no request. Check it came from this order's payer.`,
      payload: { txHash: t.tx_hash, logIndex: t.log_index, requestId: r.id },
    });
    await notifyOwner(env.DB, telegram, env.TELEGRAM_OWNER_CHAT_ID, e);
  }
  if (completedDeposit) {
    const cost = quote ? `cost ${formatCents(quote.cost_pln_grosze)} PLN gross (quote #${quote.id})` : `quote #${r.quote_id} is missing; check the cost by hand`;
    let costOb: { id: number; amount_units: number; status: string } | null = null;
    let why = "";
    if (quote && treasury) {
      if (!treasury.payoutAddress) why = "PAYOUT_ADDRESS is not set";
      else if (r.token !== "USDC") why = "only USDC payouts are configured";
      costOb = await createObligation(env.DB, {
        orderId: order.id, kind: "printer_cost", token: r.token, amountUnits: printerCostUnits(quote, fxBuffer),
        destination: treasury.payoutAddress ?? "", chain: treasury.payoutChain, dueAt: new Date(),
        sourceRef: `printer_cost:quote:${quote.id}`, status: why || late ? "escalated" : "open", ...(why ? { note: why } : {}),
      });
    }
    const move = costOb ? `Printer cost obligation #${costOb.id}: ${formatUnits(costOb.amount_units)} ${r.token} to the payout account.` : "";
    if (late && costOb && !why) {
      const e = await createEscalation(env.DB, {
        orderId: order.id, kind: "approval",
        summary: `Order ${order.id}: deposit paid LATE (due ${warsawTime(new Date(r.due_by))} Warsaw time) (${formatUnits(paid)} ${r.token}, tx ${t.tx_hash}). Approve if printing is still possible: the treasury agent then moves the printer's money and you book the printer (${cost}). ${move} Reject to handle it yourself.`,
        payload: { txHash: t.tx_hash, logIndex: t.log_index, requestId: r.id, quoteId: r.quote_id, obligationId: costOb.id },
      });
      await notifyOwner(env.DB, telegram, env.TELEGRAM_OWNER_CHAT_ID, e);
    } else {
      const manual = why ? ` The treasury agent can't move it (${why}): pay from the wallet by hand.` : "";
      const head = late
        ? `Order ${order.id}: deposit paid LATE (due ${warsawTime(new Date(r.due_by))} Warsaw time) (${formatUnits(paid)} ${r.token}, tx ${t.tx_hash}). Check printing is still possible, then book the printer: ${cost}.`
        : `Order ${order.id}: deposit paid (${formatUnits(paid)} ${r.token}, tx ${t.tx_hash}). Book the printer: ${cost}.`;
      const e = await createEscalation(env.DB, {
        orderId: order.id, kind: "payment",
        summary: `${head} ${move}${manual}`.trim(),
        payload: { txHash: t.tx_hash, logIndex: t.log_index, requestId: r.id, quoteId: r.quote_id, ...(costOb ? { obligationId: costOb.id } : {}) },
      });
      await notifyOwner(env.DB, telegram, env.TELEGRAM_OWNER_CHAT_ID, e);
    }
  }
  if (completedBalance) {
    const e = await createEscalation(env.DB, {
      orderId: order.id, kind: "payment",
      summary: `Order ${order.id}: balance paid (${formatUnits(paid)} ${r.token}, tx ${t.tx_hash}). Deliver the swag to ${order.delivery_place.replace(/\s+/g, " ")}.`,
      payload: { txHash: t.tx_hash, logIndex: t.log_index, requestId: r.id },
    });
    await notifyOwner(env.DB, telegram, env.TELEGRAM_OWNER_CHAT_ID, e);
  }
}

async function onUnmatched(env: Env, telegram: TelegramClient, t: TransferRow): Promise<void> {
  if (t.amount_units < MIN_ESCALATION_UNITS) {
    console.log("small unmatched transfer logged only", t.tx_hash, t.log_index, t.token, t.amount_units);
    return;
  }
  const e = await createEscalation(env.DB, {
    orderId: null, kind: "payment",
    summary: `Unmatched transfer: ${formatUnits(t.amount_units)} ${t.token} from ${t.from_address} (tx ${t.tx_hash}, block ${t.block_number}). No open payment request matches.`,
    payload: { txHash: t.tx_hash, logIndex: t.log_index },
  });
  await notifyOwner(env.DB, telegram, env.TELEGRAM_OWNER_CHAT_ID, e);
}

const LOCK_MS = 5 * 60_000;
const MAX_NOTIFY_ATTEMPTS = 10;

async function takeLock(db: D1Database, now: number): Promise<string | null> {
  await db.prepare("INSERT OR IGNORE INTO watcher_state (key, value) VALUES ('lock_until', '0')").run();
  const res = await db.prepare("UPDATE watcher_state SET value = ? WHERE key = 'lock_until' AND CAST(value AS INTEGER) < ?").bind(String(now + LOCK_MS), now).run();
  return res.meta.changes === 1 ? String(now + LOCK_MS) : null;
}

async function releaseLock(db: D1Database, value: string): Promise<void> {
  await db.prepare("UPDATE watcher_state SET value = '0' WHERE key = 'lock_until' AND value = ?").bind(value).run();
}

async function notifyPass(env: Env, telegram: TelegramClient): Promise<void> {
  // Side effects run separately from recording the money, so a failure here is retried on the next run.
  // A retry can repeat an escalation the owner already received; that is accepted as rare.
  for (const t of await listUnnotified(env.DB)) {
    try {
      if (t.request_id === null) {
        await onUnmatched(env, telegram, t);
      } else {
        const request = await getPaymentRequest(env.DB, t.request_id);
        if (request) await onMatched(env, telegram, { transfer: t, request, via: t.via ?? "amount" });
      }
      await markNotified(env.DB, t);
    } catch (err) {
      console.error("payment notification failed; retrying next run", t.tx_hash, t.log_index, err);
      try {
        await env.DB.prepare("UPDATE transfers SET notify_attempts = notify_attempts + 1 WHERE tx_hash = ? AND log_index = ?").bind(t.tx_hash, t.log_index).run();
        if (t.notify_attempts + 1 >= MAX_NOTIFY_ATTEMPTS) {
          const request = t.request_id === null ? null : await getPaymentRequest(env.DB, t.request_id);
          let detail = "";
          if (request) {
            detail = ` It was credited via ${t.via ?? "amount"}`;
            const paid = t.paid_after ?? request.paid_units;
            if (paid > request.amount_units) detail += `; surplus ${formatUnits(Math.min(t.amount_units, paid - request.amount_units))} ${t.token} to refund`;
            detail += ".";
          }
          const e = await createEscalation(env.DB, {
            orderId: request?.order_id ?? null, kind: "system",
            summary: `Payment notification keeps failing for tx ${t.tx_hash} (${formatUnits(t.amount_units)} ${t.token}). The payment is recorded;${detail} Check the order by hand.`,
            payload: { txHash: t.tx_hash, logIndex: t.log_index },
          });
          await markNotified(env.DB, t);
          await notifyOwner(env.DB, telegram, env.TELEGRAM_OWNER_CHAT_ID, e);
        }
      } catch (err2) {
        console.error("could not record notification failure", t.tx_hash, t.log_index, err2);
      }
    }
  }
}

/** One pass: new Transfer logs to RECEIVING_ADDRESS since the last processed block, then claimed leftovers. */
export async function runWatcher(
  env: Env,
  deps: { rpc: RpcClient; telegram?: TelegramClient; now?: Date; clock?: () => number },
): Promise<{ from: number; to: number; outcomes: TransferOutcome[] } | null> {
  if (!isAddress(env.RECEIVING_ADDRESS)) return null;
  const clock = deps.clock ?? Date.now;
  const startedAt = clock();
  const lock = await takeLock(env.DB, (deps.now ?? new Date()).getTime());
  if (lock === null) return null;
  try {
    const telegram = deps.telegram ?? createTelegram(env.TELEGRAM_BOT_TOKEN);
    const outcomes: TransferOutcome[] = [];
    const start0 = await getState(env.DB, "last_block");
    let from = start0 === null ? 0 : Number(start0) + 1;
    const start = from;
    let scanError: unknown = null;
    let failed = false;
    // A run stopped by a chain check touches nothing: the stored state may belong to another chain.
    let halted = false;
    try {
      const chain = await deps.rpc.chainId();
      if (chain !== Number(env.ARC_CHAIN_ID)) {
        halted = true;
        await alertOnce(env, telegram, "alert_chain", `RPC chain ${chain} does not match ARC_CHAIN_ID ${env.ARC_CHAIN_ID}; the payment watcher is stopped.`);
        return null;
      }
      await clearState(env.DB, "alert_chain");
      const stored = await getState(env.DB, "chain_id");
      if (stored !== null && Number(stored) !== chain) {
        halted = true;
        await alertOnce(env, telegram, "alert_state_chain", `watcher_state belongs to chain ${stored}; clear it before watching chain ${chain}.`);
        return null;
      }
      await clearState(env.DB, "alert_state_chain");
      const latest = await deps.rpc.blockNumber();
      if (start0 !== null && Number(start0) > latest + MAX_CURSOR_AHEAD_BLOCKS) {
        halted = true;
        await alertOnce(env, telegram, "alert_cursor", "last_block is ahead of the chain head; the watcher state looks stale (a testnet cursor?).");
        return null;
      }
      await clearState(env.DB, "alert_cursor");
      if (stored === null) await setState(env.DB, "chain_id", String(chain));
      let head = latest - HEAD_LAG_BLOCKS;
      if (start0 === null) {
        await setState(env.DB, "last_block", String(head));
        return null;
      }
      const filter = (fromBlock: number, toBlock: number) => ({
        fromBlock, toBlock,
        address: [USDC_SYSTEM_EMITTER, env.EURC_ADDRESS.toLowerCase()],
        topics: [TRANSFER_TOPIC, null, addressTopic(env.RECEIVING_ADDRESS)],
      });
      for (let chunk = 0; chunk < MAX_CHUNKS_PER_RUN && from <= head && clock() - startedAt < RUN_BUDGET_MS; chunk++) {
        let to = Math.min(from + CHUNK_BLOCKS - 1, head);
        let logs = await deps.rpc.getLogs(filter(from, to));
        if (deps.rpc.takeSwitched?.()) {
          // These logs came from a different node than the head: check its chain, re-read its head, and never trust blocks past it.
          if ((await deps.rpc.chainId()) !== Number(env.ARC_CHAIN_ID)) throw new Error("the fallback RPC is on another chain; its logs were discarded");
          const fresh = (await deps.rpc.blockNumber()) - HEAD_LAG_BLOCKS;
          head = Math.min(head, fresh);
          if (head < from) break;
          if (to > head) {
            to = head;
            logs = await deps.rpc.getLogs(filter(from, to));
          }
        }
        const transfers: NewTransfer[] = [];
        for (const l of logs) {
          try {
            const t = decodeTransfer(l, env.EURC_ADDRESS, env.RECEIVING_ADDRESS, { from, to });
            if (t) transfers.push(t);
          } catch (err) {
            console.error("skipping malformed log", err);
            try {
              const e = await createEscalation(env.DB, {
                orderId: null, kind: "system",
                summary: `Skipped an unreadable Transfer log (tx ${l.transactionHash}, block ${l.blockNumber}); check it by hand.`,
                payload: { txHash: l.transactionHash, logIndex: l.logIndex },
              });
              await notifyOwner(env.DB, telegram, env.TELEGRAM_OWNER_CHAT_ID, e);
            } catch (err2) {
              console.error("could not escalate skipped log", err2);
            }
          }
        }
        transfers.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
        for (const t of transfers) outcomes.push(await recordTransfer(env.DB, t, deps.now));
        await setState(env.DB, "last_block", String(to));
        from = to + 1;
      }
    } catch (err) {
      console.error("watcher scan failed", err);
      failed = true;
      scanError = err;
    } finally {
      // Claims and notifications don't wait on the RPC.
      if (!halted) {
        try {
          for (const o of await applyClaims(env.DB, deps.now)) outcomes.push(o);
        } catch (err) {
          console.error("applyClaims failed", err);
        }
        try {
          await notifyPass(env, telegram);
        } catch (err) {
          console.error("notification pass failed", err);
        }
      }
    }
    if (failed) throw scanError;
    return { from: start, to: from - 1, outcomes };
  } finally {
    await releaseLock(env.DB, lock);
  }
}
