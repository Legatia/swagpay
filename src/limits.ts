// Soft limits read from vars.

/** A numeric var, or `fallback` when it is unset, empty or not a non-negative number. */
export function envNumber(env: Env, name: string, fallback: number): number {
  const raw = (env as unknown as Record<string, unknown>)[name];
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
