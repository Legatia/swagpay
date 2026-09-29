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
});
