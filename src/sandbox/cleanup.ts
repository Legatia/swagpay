import { getAgentByName } from "agents";
import { isSandbox } from "./config";

export const SANDBOX_TTL_HOURS = 48;

/** Every R2 object of one order: its uploads and the conversation store's copies of them. By prefix, so nothing depends on the agent answering. */
async function deleteArtwork(env: Env, instance: string): Promise<void> {
  for (const prefix of [`artwork/${instance}/`, `conv/${instance}/`]) {
    let cursor: string | undefined;
    do {
      const page = await env.ARTWORK.list({ prefix, cursor, limit: 1000 });
      if (page.objects.length) await env.ARTWORK.delete(page.objects.map((x) => x.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
}

/** Deletes sandbox orders older than 48 hours with everything they own: agent state, artwork in R2 and D1 rows (children first). */
export async function cleanupSandbox(env: Env, now: Date = new Date()): Promise<{ orders: number }> {
  if (!isSandbox(env)) return { orders: 0 };
  const cutoff = new Date(now.getTime() - SANDBOX_TTL_HOURS * 3_600_000).toISOString();
  const { results } = await env.DB.prepare("SELECT id, instance FROM orders WHERE created_at < ? ORDER BY id LIMIT 50").bind(cutoff).all<{ id: number; instance: string }>();
  let orders = 0;
  for (const o of results) {
    try {
      const agent = await getAgentByName(env.OrderAgent, o.instance);
      // An agent that was never initialised (or is already destroyed) throws: no artwork, not busy, delete the rows anyway.
      const view = await agent.getView().catch(() => null);
      if (view?.busy) continue; // mid-turn: retry next hour
      await deleteArtwork(env, o.instance);
      const sp = "SELECT id FROM supplier_payments WHERE order_id = ?";
      const ob = "SELECT id FROM obligations WHERE order_id = ?";
      const pr = "SELECT id FROM payment_requests WHERE order_id = ?";
      const del = (sql: string) => env.DB.prepare(sql).bind(o.id);
      await env.DB.batch([
        del(`DELETE FROM sandbox_bank_ledger WHERE cashout_id IN (SELECT id FROM cashouts WHERE supplier_payment_id IN (${sp}))`),
        del(`DELETE FROM cashouts WHERE supplier_payment_id IN (${sp})`),
        del("DELETE FROM supplier_payments WHERE order_id = ?"),
        del("DELETE FROM printer_offers WHERE order_id = ?"),
        del(`DELETE FROM sandbox_runner_sends WHERE payout_id IN (SELECT id FROM payouts WHERE obligation_id IN (${ob}))`),
        del(`DELETE FROM payouts WHERE obligation_id IN (${ob})`),
        del("DELETE FROM obligations WHERE order_id = ?"),
        del(`DELETE FROM payment_claims WHERE request_id IN (${pr})`),
        del(`DELETE FROM transfers WHERE request_id IN (${pr})`),
        del("DELETE FROM payment_requests WHERE order_id = ?"),
        del("DELETE FROM quotes WHERE order_id = ?"),
        del("DELETE FROM vendor_jobs WHERE order_id = ?"),
        del("DELETE FROM treasury_decisions WHERE order_id = ?"),
        del("DELETE FROM decisions WHERE order_id = ?"),
        del("DELETE FROM escalations WHERE order_id = ?"),
        del("DELETE FROM order_create_keys WHERE order_id = ?"),
        del("DELETE FROM sandbox_owner_calls WHERE order_id = ?"),
        del("DELETE FROM orders WHERE id = ?"),
      ]);
      orders++;
      // Only after the rows are gone, so a failed batch never leaves an order with a destroyed agent.
      try { await agent.destroy(); } catch (err) { console.error("sandbox cleanup could not destroy the agent of order", o.id, err); }
    } catch (err) {
      console.error("sandbox cleanup failed for order", o.id, err);
    }
  }
  return { orders };
}
