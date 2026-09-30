import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CRON, handleScheduled, jobsDue, type Job } from "../src/scheduled";

describe("scheduled jobs", () => {
  it("runs the watcher every minute, FX rates at :17 and the treasury review at 07:00 UTC", () => {
    expect(jobsDue(new Date("2026-10-01T12:03:00Z"))).toEqual(["watcher"]);
    expect(jobsDue(new Date("2026-10-01T12:17:00Z"))).toEqual(["watcher", "fx"]);
    expect(jobsDue(new Date("2026-10-01T07:00:00Z"))).toEqual(["watcher", "treasury"]);
    expect(jobsDue(new Date("2026-10-01T07:17:00Z"))).toEqual(["watcher", "fx"]);
  });

  it("keeps running the other jobs when one fails, and ignores unknown crons", async () => {
    const ran: Job[] = [];
    await handleScheduled(CRON, env, new Date("2026-10-01T12:17:00Z"), async (job) => {
      ran.push(job);
      if (job === "watcher") throw new Error("rpc down");
    });
    expect(ran).toEqual(["watcher", "fx"]);
    const none: Job[] = [];
    await handleScheduled("17 * * * *", env, new Date("2026-10-01T12:17:00Z"), async (job) => { none.push(job); });
    expect(none).toEqual([]);
  });

  it("adds the sandbox runner every minute and cleanup at :37, only in the sandbox", () => {
    const sb = { ...env, SANDBOX: "1" } as unknown as Env;
    expect(jobsDue(new Date("2026-10-01T12:03:00Z"), sb)).toEqual(["watcher", "sandbox-runner"]);
    expect(jobsDue(new Date("2026-10-01T12:37:00Z"), sb)).toEqual(["watcher", "sandbox-runner", "sandbox-cleanup"]);
    expect(jobsDue(new Date("2026-10-01T12:37:00Z"), env)).toEqual(["watcher"]);
  });
});
