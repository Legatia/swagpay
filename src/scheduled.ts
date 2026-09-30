import { getAgentByName } from "agents";
import { TREASURY_NAME } from "./agent/treasury-agent";
import { createRpc } from "./arc";
import { refreshRates } from "./fx";
import { runWatcher } from "./watcher";

/**
 * One cron trigger for every scheduled job (the Workers Free plan allows 5 per account, shared with other Workers).
 * Each minute runs the payment watcher; the minute's time decides the rest.
 */
export const CRON = "* * * * *";

export type Job = "watcher" | "fx" | "treasury";

/** The jobs due at this scheduled minute (UTC): the watcher every minute, FX rates at :17, the treasury review at 07:00. */
export function jobsDue(at: Date): Job[] {
  const jobs: Job[] = ["watcher"];
  if (at.getUTCMinutes() === 17) jobs.push("fx");
  if (at.getUTCHours() === 7 && at.getUTCMinutes() === 0) jobs.push("treasury");
  return jobs;
}

async function runJob(job: Job, env: Env): Promise<void> {
  if (job === "watcher") {
    // A new client per run: it pins the first URL that answers, so the next run may pick another.
    await runWatcher(env, { rpc: createRpc([env.ARC_RPC_URL, env.ARC_RPC_FALLBACK_URL].filter((u) => u)) });
  } else if (job === "fx") {
    await refreshRates(env.DB);
  } else {
    await (await getAgentByName(env.TreasuryAgent, TREASURY_NAME)).notify("Daily review: check open, held and escalated obligations.");
  }
}

/** Runs the jobs due at `at`; one failing job never stops the others. */
export async function handleScheduled(cron: string, env: Env, at: Date = new Date(), run: (job: Job, env: Env) => Promise<void> = runJob): Promise<void> {
  if (cron !== CRON) {
    console.warn("unknown cron", cron);
    return;
  }
  const jobs = jobsDue(at);
  const results = await Promise.allSettled(jobs.map((job) => run(job, env)));
  results.forEach((r, i) => {
    if (r.status === "rejected") console.error("scheduled job failed", jobs[i], r.reason);
  });
}
