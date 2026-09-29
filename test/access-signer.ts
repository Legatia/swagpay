export const TEAM = "https://test.cloudflareaccess.com";

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

export async function makeSigner() {
  const kid = crypto.randomUUID();
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const certs = { keys: [{ kid, kty: "RSA", alg: "RS256", n: jwk.n, e: jwk.e }] };
  const fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input) !== `${TEAM}/cdn-cgi/access/certs`) return new Response("nope", { status: 404 });
    return Response.json(certs);
  }) as typeof fetch;
  const sign = async (payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid }) => {
    const data = `${b64urlJson(header)}.${b64urlJson(payload)}`;
    const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(data)));
    return `${data}.${b64url(sig)}`;
  };
  return { sign, fetchImpl };
}
