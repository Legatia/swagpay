import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import { createOrder } from "../src/db";
import { createEscalation, decideEscalation, getEscalation } from "../src/escalations";
import { CRON, handleScheduled, jobsDue, resendDecisions, type Job } from "../src/scheduled";
import { intakeFor } from "./fixtures";

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

  it("adds the sandbox runner and re-delivery every minute and cleanup at :37, only in the sandbox", () => {
    const sb = { ...env, SANDBOX: "1" } as unknown as Env;
    expect(jobsDue(new Date("2026-10-01T12:03:00Z"), sb)).toEqual(["watcher", "sandbox-runner", "sandbox-resend"]);
    expect(jobsDue(new Date("2026-10-01T12:37:00Z"), sb)).toEqual(["watcher", "sandbox-runner", "sandbox-resend", "sandbox-cleanup"]);
    expect(jobsDue(new Date("2026-10-01T12:37:00Z"), env)).toEqual(["watcher"]);
  });

  it("sandbox re-delivery tells the agent about decided, undelivered escalations and leaves open ones", async () => {
    const { order } = await createOrder(env.DB, intakeFor(), new Date("2099-10-01T10:00:00Z"));
    await (await getAgentByName(env.OrderAgent, order.instance)).init(order.id, intakeFor());
    const decided = await createEscalation(env.DB, { orderId: order.id, kind: "approval", summary: "Approve: banner", payload: {} });
    const open = await createEscalation(env.DB, { orderId: order.id, kind: "approval", summary: "Approve: flag", payload: {} });
    await decideEscalation(env.DB, decided.id, "approved", null);
    expect((await getEscalation(env.DB, decided.id))?.delivered_at).toBeNull();
    await resendDecisions(env);
    expect((await getEscalation(env.DB, decided.id))?.delivered_at).toBeTruthy();
    expect(await getEscalation(env.DB, open.id)).toMatchObject({ status: "open", delivered_at: null });
  });

  it("sandbox re-delivery logs a failure and never throws", async () => {
    const { order } = await createOrder(env.DB, intakeFor(), new Date("2099-10-01T10:00:00Z"));
    const e = await createEscalation(env.DB, { orderId: order.id, kind: "approval", summary: "Approve: banner", payload: {} });
    await decideEscalation(env.DB, e.id, "approved", null);
    const unreachable = { idFromName() { throw new Error("agent unreachable"); } } as unknown as Env["OrderAgent"];
    await expect(resendDecisions({ ...env, OrderAgent: unreachable } as Env)).resolves.toBeUndefined();
    const broken = { ...env, DB: { prepare() { throw new Error("db down"); } } } as unknown as Env;
    await expect(resendDecisions(broken)).resolves.toBeUndefined();
  });
});
