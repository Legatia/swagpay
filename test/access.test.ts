import { describe, expect, it } from "vitest";
import { verifyAccessJwt } from "../src/access";
import { TEAM, makeSigner } from "./access-signer";

const good = (now: number) => ({ aud: ["test-aud"], iss: TEAM, exp: Math.floor(now / 1000) + 600, email: "owner@example.com" });

describe("verifyAccessJwt", () => {
  it("accepts a valid token and returns the email", async () => {
    const { sign, fetchImpl } = await makeSigner();
    const now = Date.now();
    expect(await verifyAccessJwt(await sign(good(now)), TEAM, "test-aud", fetchImpl, now)).toEqual({ email: "owner@example.com" });
  });

  it("refuses wrong audience, wrong issuer, expiry, bad signature, alg none and junk", async () => {
    const { sign, fetchImpl } = await makeSigner();
    const other = await makeSigner();
    const now = Date.now();
    expect(await verifyAccessJwt(await sign({ ...good(now), aud: ["other"] }), TEAM, "test-aud", fetchImpl, now)).toBeNull();
    expect(await verifyAccessJwt(await sign({ ...good(now), iss: "https://evil.example" }), TEAM, "test-aud", fetchImpl, now)).toBeNull();
    expect(await verifyAccessJwt(await sign({ ...good(now), exp: Math.floor(now / 1000) - 1 }), TEAM, "test-aud", fetchImpl, now)).toBeNull();
    const forged = await other.sign(good(now));
    expect(await verifyAccessJwt(forged, TEAM, "test-aud", fetchImpl, now)).toBeNull();
    expect(await verifyAccessJwt(await sign(good(now), { alg: "none" }), TEAM, "test-aud", fetchImpl, now)).toBeNull();
    expect(await verifyAccessJwt("a.b", TEAM, "test-aud", fetchImpl, now)).toBeNull();
    expect(await verifyAccessJwt(null, TEAM, "test-aud", fetchImpl, now)).toBeNull();
    expect(await verifyAccessJwt(await sign(good(now)), TEAM, "", fetchImpl, now)).toBeNull();
  });

  it("accepts a team domain written with a trailing slash", async () => {
    const { sign, fetchImpl } = await makeSigner();
    const now = Date.now();
    expect(await verifyAccessJwt(await sign(good(now)), `${TEAM}/`, "test-aud", fetchImpl, now)).toEqual({ email: "owner@example.com" });
  });

  it("refuses a token signed by another key under the real kid, and a tampered payload", async () => {
    const real = await makeSigner();
    const other = await makeSigner();
    const now = Date.now();
    const forged = await other.sign(good(now), { alg: "RS256", kid: real.kid });
    expect(await verifyAccessJwt(forged, TEAM, "test-aud", real.fetchImpl, now)).toBeNull();
    const valid = await real.sign(good(now));
    const [h, , s] = valid.split(".");
    const evil = btoa(JSON.stringify({ ...good(now), email: "attacker@example.com" })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await verifyAccessJwt(`${h}.${evil}.${s}`, TEAM, "test-aud", real.fetchImpl, now)).toBeNull();
    expect(await verifyAccessJwt(valid, TEAM, "test-aud", real.fetchImpl, now)).toEqual({ email: "owner@example.com" });
  });

  it("reuses cached certs for a known kid", async () => {
    const s = await makeSigner();
    const now = Date.now();
    const token = await s.sign(good(now));
    await verifyAccessJwt(token, TEAM, "test-aud", s.fetchImpl, now);
    const before = s.fetches();
    expect(await verifyAccessJwt(token, TEAM, "test-aud", s.fetchImpl, now)).toEqual({ email: "owner@example.com" });
    expect(s.fetches()).toBe(before);
  });

  it("fails closed when the certs fetch throws", async () => {
    const { sign } = await makeSigner();
    const now = Date.now();
    const offline = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    expect(await verifyAccessJwt(await sign(good(now)), TEAM, "test-aud", offline, now)).toBeNull();
  });
});
