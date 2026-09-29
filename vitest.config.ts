import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            AGENT_AUTORUN: "0",
            ANTHROPIC_API_KEY: "test-key",
            MAX_NEW_ORDERS_PER_DAY: "50",
            REQUIRE_TURNSTILE: "0",
            TELEGRAM_OWNER_CHAT_ID: "42",
            TELEGRAM_BOT_TOKEN: "",
            TELEGRAM_WEBHOOK_SECRET: "test-secret",
            ACCESS_TEAM_DOMAIN: "https://test.cloudflareaccess.com",
            ACCESS_AUD: "test-aud",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
