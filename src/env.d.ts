declare namespace Cloudflare {
  interface Env {
    ANTHROPIC_API_KEY?: string;
    GEMINI_API_KEY?: string;
    TURNSTILE_SECRET?: string;
    TELEGRAM_BOT_TOKEN?: string;
    TELEGRAM_OWNER_CHAT_ID?: string;
    TELEGRAM_WEBHOOK_SECRET?: string;
    TREASURY_RUNNER_TOKEN?: string;
    PAYOUT_ADDRESS?: string;
  }
}

// `wrangler types` (4.x) declares the global Env separately from Cloudflare.Env,
// so secrets added above would not reach it. Merge them.
interface Env extends Cloudflare.Env {}
