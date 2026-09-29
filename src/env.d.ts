declare namespace Cloudflare {
  interface Env {
    ANTHROPIC_API_KEY: string;
    TURNSTILE_SECRET?: string;
  }
}

// `wrangler types` (4.x) declares the global Env separately from Cloudflare.Env,
// so secrets added above would not reach it. Merge them.
interface Env extends Cloudflare.Env {}
