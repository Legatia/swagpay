function base64url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Bytes as a one-byte-per-char string (for btoa and byte-level regexes). */
export function binaryString(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
}

export function toBase64(bytes: Uint8Array): string {
  return btoa(binaryString(bytes));
}

export function newToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return base64url(b);
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newInstanceName(): string {
  return `order-${crypto.randomUUID()}`;
}

export function newFileId(): string {
  return crypto.randomUUID();
}
