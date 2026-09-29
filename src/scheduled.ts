import { createRpc } from "./arc";
import { refreshRates } from "./fx";
import { runWatcher } from "./watcher";

export const FX_CRON = "17 * * * *";

export async function handleScheduled(cron: string, env: Env): Promise<void> {
  if (cron === FX_CRON) {
    await refreshRates(env.DB);
    return;
  }
  await runWatcher(env, { rpc: createRpc([env.ARC_RPC_URL, env.ARC_RPC_FALLBACK_URL].filter((u) => u)) });
}
