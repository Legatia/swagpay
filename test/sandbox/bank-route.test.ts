import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleApi } from "../../src/api";

const url = "https://sandbox.test/api/sandbox/bank";

describe("sandbox bank route", () => {
  it("answers 404 when SANDBOX is unset", async () => {
    const res = await handleApi(new Request(url), { ...env, SANDBOX: undefined } as unknown as Env);
    expect(res.status).toBe(404);
  });

  it("answers 200 with an empty ledger in the sandbox", async () => {
    const res = await handleApi(new Request(url), { ...env, SANDBOX: "1" } as unknown as Env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cashouts: [] });
  });
});
