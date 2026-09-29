import { getAgentByName } from "agents";
import { TREASURY_NAME } from "./agent/treasury-agent";
import { createRpc } from "./arc";
import { refreshRates } from "./fx";
import { runWatcher } from "./watcher";

export const WATCHER_CRON = "* * * * *";
export const FX_CRON = "17 * * * *";
export const TREASURY_CRON = "0 7 * * *";

export async function handleScheduled(cron: string, env: Env): Promise<void> {
  if (cron === FX_CRON) {
    await refreshRates(env.DB);
  } else if (cron === WATCHER_CRON) {
    // A new client per run: it pins the first URL that answers, so the next run may pick another.
    await runWatcher(env, { rpc: createRpc([env.ARC_RPC_URL, env.ARC_RPC_FALLBACK_URL].filter((u) => u)) });
  } else if (cron === TREASURY_CRON) {
    await (await getAgentByName(env.TreasuryAgent, TREASURY_NAME)).notify("Daily review: check open, held and escalated obligations.");
  } else {
    console.warn("unknown cron", cron);
  }
}
