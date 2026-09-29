# Swagpay

Event swag (t-shirts and stickers) printed by local printers and paid in USDC or EURC on Arc.
An AI agent runs each order. Design: `docs/design.md`.

## Develop

    npm install
    npm run types
    npm test
    printf 'ANTHROPIC_API_KEY=sk-ant-...\nTURNSTILE_SECRET=1x0000000000000000000000000000000AA\n' > .dev.vars
    npm run dev

## Deploy (owner)

    npx wrangler d1 create swagpay            # put the printed database_id into wrangler.jsonc
    npx wrangler r2 bucket create swagpay-artwork
    npx wrangler d1 migrations apply swagpay --remote
    npx wrangler secret put ANTHROPIC_API_KEY  # a Claude Console API key
    npm run deploy

## Owner setup (plan 2)

Secrets (`npx wrangler secret put <NAME>`; for local dev put them in `.dev.vars`):

| Secret | What it is |
|---|---|
| `ANTHROPIC_API_KEY` | Claude Console API key |
| `TURNSTILE_SECRET` | Turnstile widget secret (dev: `1x0000000000000000000000000000000AA`, always passes) |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_OWNER_CHAT_ID` | Your private chat id with the bot, never a group: message the bot, then read `chat.id` from `getUpdates`. Anyone in a group chat could press the buttons. |
| `TELEGRAM_WEBHOOK_SECRET` | A long random string of letters, digits, `_` and `-` only (e.g. `openssl rand -hex 32`); Telegram sends it back on every update |

Vars in `wrangler.jsonc`:

| Var | Set to |
|---|---|
| `TURNSTILE_SITE_KEY` | Your Turnstile widget's site key (the default is Cloudflare's always-pass test key) |
| `REQUIRE_TURNSTILE` | `"1"` (new orders need the human check; without a secret every order is refused) |
| `ACCESS_TEAM_DOMAIN` | `https://<team>.cloudflareaccess.com` |
| `ACCESS_AUD` | The audience tag of the Access application that protects `/admin` |

Point Telegram at the Worker once:

    curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
      -d url=https://<your-domain>/api/telegram \
      -d secret_token=$TELEGRAM_WEBHOOK_SECRET \
      -d 'allowed_updates=["message","callback_query"]'

In Cloudflare Zero Trust, create a self-hosted Access application for `https://<your-domain>/admin*`
that allows only your email, and copy its audience tag into `ACCESS_AUD`.
Once the custom domain serves the Worker, set `"workers_dev": false` in `wrangler.jsonc` so only Access-protected routes reach `/admin`.

Telegram commands: `/open`, `/approve <id> [note]`, `/reject <id> [note]`, `/resend <id>` (re-send a decision the agent missed), `/order <number>`.
Apply the new migration remotely before deploying: `npx wrangler d1 migrations apply swagpay --remote`.
