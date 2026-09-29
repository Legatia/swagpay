import { getAgentByName } from "agents";
import { TRANSFER_TOPIC, USDC_SYSTEM_EMITTER, addressTopic, decodeTransfer, type RpcClient } from "./arc";
import { getOrderById, setOrderStatus } from "./db";
import { createEscalation } from "./escalations";
import { formatUnits, isAddress } from "./money";
import { applyClaims, depositPaid, getPaymentRequest, listUnnotified, markNotified, recordTransfer, type NewTransfer, type PaymentRequestRow, type TransferOutcome, type TransferRow } from "./payments";
import { createTelegram, notifyOwner, type TelegramClient } from "./telegram";

export const CHUNK_BLOCKS = 5000;
export const MAX_CHUNKS_PER_RUN = 20;
/** Stay this many blocks behind the head (about 19 seconds on Arc) so a lagging node cannot skip a log we then mark processed. */
export const HEAD_LAG_BLOCKS = 30;
/** Unmatched transfers below 0.01 of a token are logged, not escalated. */
export const MIN_ESCALATION_UNITS = 10_000;

async function getState(db: D1Database, key: string): Promise<string | null> {
  return (await db.prepare("SELECT value FROM watcher_state WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;
}

async function setState(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare("INSERT OR REPLACE INTO watcher_state (key, value) VALUES (?, ?)").bind(key, value).run();
}

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
  if (r.stage === "deposit" && (await depositPaid(env.DB, order.id))) {
    // "quoted" too: if the accept route could not move the order to deposit_pending, the deposit still completes it. Idempotent.
    await setOrderStatus(env.DB, order.id, ["quoted", "deposit_pending"], "deposit_paid");
    if (paid - t.amount_units < r.amount_units && paid >= r.amount_units) text += " The deposit is fully paid.";
  }
  const surplus = paid > r.amount_units ? Math.min(t.amount_units, paid - r.amount_units) : 0;
  if (surplus > 0) text += ` Overpaid by ${formatUnits(surplus)} ${r.token}; the owner will refund it.`;
  const agent = await getAgentByName(env.OrderAgent, order.instance);
  await agent.pushEvent(text, `Payment received: ${got}.`);
  // Owner escalations come last, so a failing agent call cannot repeat owner pings on every retry.
  if (surplus > 0) {
    const e = await createEscalation(env.DB, {
      orderId: order.id, kind: "payment",
      summary: `Order ${order.id} overpaid by ${formatUnits(surplus)} ${r.token} (tx ${t.tx_hash}). Surplus sent from ${t.from_address}; confirm the refund address with the payer (exchanges and bridges send from shared addresses).`,
      payload: { txHash: t.tx_hash, logIndex: t.log_index, surplus },
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
}

async function onUnmatched(env: Env, telegram: TelegramClient, t: TransferRow): Promise<void> {
  if (t.amount_units < MIN_ESCALATION_UNITS) {
    console.log("dust transfer ignored", t.tx_hash, t.log_index, t.amount_units);
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

async function takeLock(db: D1Database, now: number): Promise<boolean> {
  await db.prepare("INSERT OR IGNORE INTO watcher_state (key, value) VALUES ('lock_until', '0')").run();
  const res = await db.prepare("UPDATE watcher_state SET value = ? WHERE key = 'lock_until' AND CAST(value AS INTEGER) < ?").bind(String(now + LOCK_MS), now).run();
  return res.meta.changes === 1;
}

async function releaseLock(db: D1Database): Promise<void> {
  await db.prepare("UPDATE watcher_state SET value = '0' WHERE key = 'lock_until'").run();
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
          const e = await createEscalation(env.DB, {
            orderId: request?.order_id ?? null, kind: "system",
            summary: `Payment notification keeps failing for tx ${t.tx_hash} (${formatUnits(t.amount_units)} ${t.token}). The payment is recorded; check the order by hand.`,
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
  deps: { rpc: RpcClient; telegram?: TelegramClient; now?: Date },
): Promise<{ from: number; to: number; outcomes: TransferOutcome[] } | null> {
  if (!isAddress(env.RECEIVING_ADDRESS)) return null;
  if (!(await takeLock(env.DB, (deps.now ?? new Date()).getTime()))) return null;
  try {
    const telegram = deps.telegram ?? createTelegram(env.TELEGRAM_BOT_TOKEN);
    const outcomes: TransferOutcome[] = [];
    const start0 = await getState(env.DB, "last_block");
    let from = start0 === null ? 0 : Number(start0) + 1;
    const start = from;
    let scanError: unknown = null;
    let failed = false;
    try {
      const head = (await deps.rpc.blockNumber()) - HEAD_LAG_BLOCKS;
      if (start0 === null) {
        await setState(env.DB, "last_block", String(head));
        return null;
      }
      for (let chunk = 0; chunk < MAX_CHUNKS_PER_RUN && from <= head; chunk++) {
        const to = Math.min(from + CHUNK_BLOCKS - 1, head);
        const logs = await deps.rpc.getLogs({
          fromBlock: from, toBlock: to,
          address: [USDC_SYSTEM_EMITTER, env.EURC_ADDRESS.toLowerCase()],
          topics: [TRANSFER_TOPIC, null, addressTopic(env.RECEIVING_ADDRESS)],
        });
        const transfers: NewTransfer[] = [];
        for (const l of logs) {
          try {
            const t = decodeTransfer(l, env.EURC_ADDRESS);
            if (t) transfers.push(t);
          } catch (err) {
            console.error("skipping malformed log", err);
          }
        }
        transfers.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
        for (const t of transfers) outcomes.push(await recordTransfer(env.DB, t, deps.now));
        await setState(env.DB, "last_block", String(to));
        from = to + 1;
      }
    } catch (err) {
      failed = true;
      scanError = err;
    } finally {
      // Claims and notifications don't wait on the RPC.
      for (const o of await applyClaims(env.DB, deps.now)) outcomes.push(o);
      await notifyPass(env, telegram);
    }
    if (failed) throw scanError;
    return { from: start, to: from - 1, outcomes };
  } finally {
    await releaseLock(env.DB);
  }
}
