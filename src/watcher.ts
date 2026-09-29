import { getAgentByName } from "agents";
import { TRANSFER_TOPIC, USDC_SYSTEM_EMITTER, addressTopic, decodeTransfer, type RpcClient } from "./arc";
import { getOrderById, setOrderStatus } from "./db";
import { createEscalation } from "./escalations";
import { formatUnits, isAddress } from "./money";
import { applyClaims, depositPaid, getPaymentRequest, listUnnotified, markNotified, recordTransfer, type PaymentRequestRow, type TransferOutcome, type TransferRow } from "./payments";
import { createTelegram, notifyOwner, type TelegramClient } from "./telegram";

export const CHUNK_BLOCKS = 5000;
export const MAX_CHUNKS_PER_RUN = 20;
/** Stay this many blocks behind the head (about 3 seconds on Arc) so a lagging node cannot skip a log we then mark processed. */
export const HEAD_LAG_BLOCKS = 5;
/** Unmatched transfers below 0.01 of a token are logged, not escalated. */
export const MIN_ESCALATION_UNITS = 10_000;

async function getState(db: D1Database, key: string): Promise<string | null> {
  return (await db.prepare("SELECT value FROM watcher_state WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;
}

async function setState(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare("INSERT OR REPLACE INTO watcher_state (key, value) VALUES (?, ?)").bind(key, value).run();
}

/** Tells the order's agent (and the host's thread) about a credited transfer; escalates overpayment. */
async function onMatched(env: Env, telegram: TelegramClient, o: { transfer: TransferRow; request: PaymentRequestRow; via: "amount" | "claim" }): Promise<void> {
  const r = o.request;
  const order = await getOrderById(env.DB, r.order_id);
  if (!order) return;
  const got = `${formatUnits(o.transfer.amount_units)} ${r.token}`;
  let text = `Payment received on Arc: ${got} for ${r.stage} request #${r.id} (tx ${o.transfer.tx_hash}). Paid ${formatUnits(r.paid_units)} of ${formatUnits(r.amount_units)}.`;
  if (r.paid_units < r.amount_units) text += ` Still due: ${formatUnits(r.amount_units - r.paid_units)} ${r.token}.`;
  if (r.stage === "deposit" && (await depositPaid(env.DB, order.id))) {
    // "quoted" too: if the accept route could not move the order to deposit_pending, the deposit still completes it. Idempotent.
    await setOrderStatus(env.DB, order.id, ["quoted", "deposit_pending"], "deposit_paid");
    if (r.paid_units - o.transfer.amount_units < r.amount_units && r.paid_units >= r.amount_units) text += " The deposit is fully paid.";
  }
  if (r.paid_units > r.amount_units) {
    const surplus = Math.min(o.transfer.amount_units, r.paid_units - r.amount_units);
    text += ` Overpaid by ${formatUnits(surplus)} ${r.token}; the owner will refund it.`;
    const e = await createEscalation(env.DB, {
      orderId: order.id, kind: "payment",
      summary: `Order ${order.id} overpaid by ${formatUnits(surplus)} ${r.token} (tx ${o.transfer.tx_hash}). Surplus sent from ${o.transfer.from_address}; confirm the refund address with the payer (exchanges and bridges send from shared addresses).`,
      payload: { txHash: o.transfer.tx_hash, logIndex: o.transfer.log_index, surplus },
    });
    await notifyOwner(env.DB, telegram, env.TELEGRAM_OWNER_CHAT_ID, e);
  }
  if (o.via === "claim") {
    // Anyone can paste a public tx hash; the amount matched nothing, so the owner checks it really came from this payer.
    const e = await createEscalation(env.DB, {
      orderId: order.id, kind: "payment",
      summary: `Order ${order.id}: ${got} (tx ${o.transfer.tx_hash}) was credited to ${r.stage} request #${r.id} because the payer pasted its hash; the amount matched no request. Check it came from this order's payer.`,
      payload: { txHash: o.transfer.tx_hash, logIndex: o.transfer.log_index, requestId: r.id },
    });
    await notifyOwner(env.DB, telegram, env.TELEGRAM_OWNER_CHAT_ID, e);
  }
  const agent = await getAgentByName(env.OrderAgent, order.instance);
  await agent.pushEvent(text, `Payment received: ${got}.`);
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

/** One pass: new Transfer logs to RECEIVING_ADDRESS since the last processed block, then claimed leftovers. */
export async function runWatcher(
  env: Env,
  deps: { rpc: RpcClient; telegram?: TelegramClient; now?: Date },
): Promise<{ from: number; to: number; outcomes: TransferOutcome[] } | null> {
  if (!isAddress(env.RECEIVING_ADDRESS)) return null;
  const telegram = deps.telegram ?? createTelegram(env.TELEGRAM_BOT_TOKEN);
  const head = (await deps.rpc.blockNumber()) - HEAD_LAG_BLOCKS;
  const last = await getState(env.DB, "last_block");
  if (last === null) {
    await setState(env.DB, "last_block", String(head));
    return null;
  }
  const start = Number(last) + 1;
  const outcomes: TransferOutcome[] = [];
  let from = start;
  for (let chunk = 0; chunk < MAX_CHUNKS_PER_RUN && from <= head; chunk++) {
    const to = Math.min(from + CHUNK_BLOCKS - 1, head);
    const logs = await deps.rpc.getLogs({
      fromBlock: from, toBlock: to,
      address: [USDC_SYSTEM_EMITTER, env.EURC_ADDRESS.toLowerCase()],
      topics: [TRANSFER_TOPIC, null, addressTopic(env.RECEIVING_ADDRESS)],
    });
    const transfers = logs.map((l) => decodeTransfer(l, env.EURC_ADDRESS)).filter((t) => t !== null)
      .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    for (const t of transfers) {
      outcomes.push(await recordTransfer(env.DB, t, deps.now));
    }
    await setState(env.DB, "last_block", String(to));
    from = to + 1;
  }
  for (const o of await applyClaims(env.DB, deps.now)) {
    outcomes.push(o);
    // It may already have been announced as unmatched; announce it again as matched (and flag the claim).
    if (o.kind === "matched") {
      await env.DB.prepare("UPDATE transfers SET notified_at = NULL WHERE tx_hash = ? AND log_index = ?").bind(o.transfer.tx_hash, o.transfer.log_index).run();
    }
  }
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
    }
  }
  return { from: start, to: from - 1, outcomes };
}
