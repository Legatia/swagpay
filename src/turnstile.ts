export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** True only when Cloudflare confirms the token; any other outcome is false. */
export async function verifyTurnstile(token: unknown, ip: string | null, secret: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) return false;
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  try {
    const res = await fetchImpl(SITEVERIFY_URL, { method: "POST", body: form });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: unknown };
    return data.success === true;
  } catch {
    return false;
  }
}
