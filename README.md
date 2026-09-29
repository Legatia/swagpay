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

## Payments and quotes (plan 3)

- `RECEIVING_ADDRESS`: the Arc address of the owner's Circle agent wallet. While it is empty, hosts cannot accept quotes and the watcher does nothing.
- `ARC_RPC_URL` defaults to Blockdaemon's keyless endpoint. The official RPC rate-limits `eth_getLogs` from Cloudflare. `ARC_RPC_FALLBACK_URL` is optional; an Alchemy Arc URL with a key is a good choice.
- `ARC_CHAIN_ID`, `USDC_ADDRESS`, `EURC_ADDRESS`: mainnet values are set.
- Testnet rehearsal: use a separate D1 database, or clear `watcher_state` and the payment tables before and after:

      npx wrangler d1 execute swagpay --remote --command "DELETE FROM payment_claims; DELETE FROM transfers; DELETE FROM payment_requests; DELETE FROM watcher_state;"

  Set `ARC_CHAIN_ID=5042002`, the testnet `EURC_ADDRESS` (`0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`), and point `ARC_RPC_URL` and `ARC_RPC_FALLBACK_URL` at testnet RPC URLs.
  The watcher records the chain it watches in `watcher_state`. It stops, and tells you once in Telegram, when the RPC's chain differs from `ARC_CHAIN_ID`, when `watcher_state` belongs to another chain, or when its cursor is more than 1,000 blocks ahead of the chain head.
- Crons:
  - `* * * * *` runs the payment watcher. It stays 30 blocks (about 20 seconds) behind the chain head, and only one run works at a time. The first run only records where to start: let it run once before any host accepts a quote. Notifications (the agent event, order status, owner notices) retry every minute and, after 10 failures, alert the owner.
  - `17 * * * *` refreshes the NBP złoty rates. Quotes are refused while the rates are older than 6 hours.
- Printer cost: when an order is complete, the agent asks you in Telegram. Reply `/cost <#> <PLN gross, delivery included> [printer]`. The agent then quotes inside the markup band.
- Payments: the watcher matches USDC (native, from Arc's system emitter) and EURC transfers to `RECEIVING_ADDRESS`. Matching order: the exact amount still due, then the 4-digit tag for a short payment, then a transaction hash the payer pasted (every credit made through a pasted hash is flagged to the owner). Over-sized tagged payments and anything unmatched go to the owner. Unmatched transfers under 1 USDC/EURC are only logged. An overpayment and every completed deposit also open a payment escalation in Telegram.
- Apply the migrations before deploying: `npx wrangler d1 migrations apply swagpay --remote`.

## Design editor intake (plan 4a)

The design editor (`/design/`, built separately) creates orders with `designPending: true`. It then uploads files with a `role` (`artwork`, `mockup`, `print`, `cutline`) and posts its v1 design JSON to `POST /api/o/<token>/design`. The schema lives in `src/design-spec.ts`: changing its shape means a new `version` and an update to the editor. A design is limited to 64 KB. `sizes` keys are XS, S, M, L, XL, XXL, 3XL (`"2XL"` is accepted as XXL); `sticker` is `null` for non-sticker products. Designs are refused once a quote has been accepted.
