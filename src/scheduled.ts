import { getAgentByName } from "agents";
import { TREASURY_NAME } from "./agent/treasury-agent";
import { createRpc } from "./arc";
import { refreshRates } from "./fx";
import { cleanupSandbox } from "./sandbox/cleanup";
import { isSandbox } from "./sandbox/config";
import { runSandboxRunner } from "./sandbox/runner";
import { resend } from "./telegram-webhook";
import { runWatcher } from "./watcher";

/**
 * One cron trigger for every scheduled job (the Workers Free plan allows 5 per account, shared with other Workers).
 * Each minute runs the payment watcher; the minute's time decides the rest.
 */
export const CRON = "* * * * *";

export type Job = "watcher" | "fx" | "treasury" | "sandbox-runner" | "sandbox-resend" | "sandbox-cleanup";

/** The jobs due at this scheduled minute (UTC): the watcher every minute, FX rates at :17, the treasury review at 07:00. */
export function jobsDue(at: Date, env?: Env): Job[] {
  const jobs: Job[] = ["watcher"];
  if (at.getUTCMinutes() === 17) jobs.push("fx");
  if (at.getUTCHours() === 7 && at.getUTCMinutes() === 0) jobs.push("treasury");
  if (env && isSandbox(env)) {
    jobs.push("sandbox-runner", "sandbox-resend");
    if (at.getUTCMinutes() === 37) jobs.push("sandbox-cleanup");
  }
  return jobs;
}

const RESEND_WINDOW_MS = 6 * 3_600_000;
const RESEND_MAX_PER_RUN = 20;
const isPowerOfTwo = (n: number) => n >= 1 && (n & (n - 1)) === 0;

/**
 * Sandbox: re-sends decided escalations the agent has not heard (the owner's /resend path). A decision is tried once its age in whole
 * minutes is a power of two (1, 2, 4 ... 256), so a failing one backs off and is left alone after about 4.3 hours; a fresh decision
 * (under a minute) is left to decide()'s own delivery. Logs failures; never throws.
 */
export async function resendDecisions(env: Env, now: Date = new Date()): Promise<void> {
  try {
    const rows = (await env.DB
      .prepare("SELECT id, decided_at FROM escalations WHERE status != 'open' AND delivered_at IS NULL AND decided_at BETWEEN ? AND ? ORDER BY decided_at ASC")
      .bind(new Date(now.getTime() - RESEND_WINDOW_MS).toISOString(), new Date(now.getTime() - 60_000).toISOString())
      .all<{ id: number; decided_at: string }>()).results;
    const due = rows.filter((r) => isPowerOfTwo(Math.floor((now.getTime() - Date.parse(r.decided_at)) / 60_000))).slice(0, RESEND_MAX_PER_RUN);
    for (const e of due) {
      try {
        await resend(env, e.id);
      } catch (err) {
        console.error("sandbox resend failed", e.id, err);
      }
    }
  } catch (err) {
    console.error("sandbox resend failed", err);
  }
}

async function runJob(job: Job, env: Env): Promise<void> {
  if (job === "watcher") {
    // A new client per run: it pins the first URL that answers, so the next run may pick another.
    await runWatcher(env, { rpc: createRpc([env.ARC_RPC_URL, env.ARC_RPC_FALLBACK_URL].filter((u) => u)) });
  } else if (job === "fx") {
    await refreshRates(env.DB);
  } else if (job === "sandbox-runner") {
    await runSandboxRunner(env);
  } else if (job === "sandbox-resend") {
    await resendDecisions(env);
  } else if (job === "sandbox-cleanup") {
    await cleanupSandbox(env);
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
  const jobs = jobsDue(at, env);
  const results = await Promise.allSettled(jobs.map((job) => run(job, env)));
  results.forEach((r, i) => {
    if (r.status === "rejected") console.error("scheduled job failed", jobs[i], r.reason);
  });
}
