# Swagpay

Event swag (t-shirts and stickers) printed by local printers and paid in USDC or EURC on Arc.
An AI agent runs each order. Design: `docs/design.md`.
Brand kit: `docs/brand.md` (visual preview at `/brandkit.html`).

## Develop

    npm install
    npm run types
    npm test
    printf 'GEMINI_API_KEY=...\nTURNSTILE_SECRET=1x0000000000000000000000000000000AA\n' > .dev.vars
    npm run dev

## Model

Both agents (order and treasury) run on one model, chosen in `wrangler.jsonc`:

| Var | Set to |
|---|---|
| `MODEL_PROVIDER` | `gemini` (default here) or `anthropic` |
| `GEMINI_MODEL` | e.g. `gemini-3.8-flash` (Google's recommended model for agents) |
| `MODEL` | the Claude model, used when `MODEL_PROVIDER` is `anthropic` |

Gemini runs through `src/agent/gemini.ts`, which translates the agents' requests to `generateContent` and back:
tools go as JSON Schema (`parametersJsonSchema`), artwork previews as inline data, and Gemini's thought signatures
are kept on each call and sent back, which multi-step tool use needs. Switching providers keeps existing
conversations working. The key only ever travels in the `x-goog-api-key` header; errors never include it.

## Printers (vendor network)

Apply migration 0006 BEFORE `wrangler deploy` (`npx wrangler d1 migrations apply swagpay --remote`): the new code reads the vendor tables.

Import the researched printers, run from the swagpay folder. It never demotes a partner or paused printer and never overwrites a payout address:

    node scripts/vendors-import.mjs ../event-swag/data/*-printers.json > /tmp/vendors.sql && npx wrangler d1 execute swagpay --remote --file /tmp/vendors.sql

A printer is `screened` when it has an email and its tax check passed: an active Polish VAT, a valid VAT number (VIES, as the Lisbon research records it: `valid: true; …`), or an active UK company record. Every other printer is a `candidate`. A re-import keeps partners and paused printers as they are, but sets every other status from the data: a printer you screened by hand with `/vendor <#> screened` goes back to `candidate` unless its data qualifies.

Owner commands in Telegram:
- `/vendors [city]` lists printers.
- `/vendor <#> partner|screened|paused` sets a printer's status.
- `/vendor <#> pay <0x address> <CHAIN>` registers where a printer is paid.
- `/cost <#> <amount> [PLN|EUR|GBP|USD|INR] [v<printer #>] [note]` records an order's printer cost, optionally against a printer.

How a partner is paid: the printer cost goes out as two milestones, half at deposit and half after `/printed`. The second never goes out before `/printed`, and together they add up to the printer's cost at the quote's rate, without the FX buffer: the buffer stays in the wallet as margin. Agree that USDC amount with the printer when you book it. Money goes only to the printer's registered address and chain, only while it is a `partner`, and within the per-payout and 24-hour limits.

A milestone stays fixed to the address and chain the printer had when the deposit came in. When the printer is paused, or registers another address or chain, the treasury stops paying it, and you decide in Telegram:
- **Already queued.** When the wallet runner next fetches payouts, the payout is withheld and comes to you as an approval. Withholding is best-effort: if the runner fetched that batch just before, the payout may still go out, so check the wallet history first. Approve to retry once the printer is registered again, or reject to settle it by hand.
- **Not a partner** (paused, or back to screened). Approve once the printer is a partner with its payout registered again (the treasury re-checks), or reject if you pay it by hand or it isn't owed.
- **Address or chain changed.** Approving alone would come straight back: the milestone still goes to the old address. Re-register that address with `/vendor <#> pay <old address> <CHAIN>` and approve, or reject and pay the printer by hand (that settles it).

Pausing or screening a partner clears its payout; the reply shows what was cleared.

Lead times still count Polish business days. `/log` and `/api/metrics` show vendor counts and USDC paid only, never a printer's name.

## Deploy (owner)

    npx wrangler d1 create swagpay            # put the printed database_id into wrangler.jsonc
    npx wrangler r2 bucket create swagpay-artwork
    npx wrangler d1 migrations apply swagpay --remote
    npx wrangler secret put GEMINI_API_KEY     # a Google AI Studio API key (or ANTHROPIC_API_KEY, see "Model")
    npm run deploy

## Owner setup (plan 2)

Secrets (`npx wrangler secret put <NAME>`; for local dev put them in `.dev.vars`):

| Secret | What it is |
|---|---|
| `GEMINI_API_KEY` | Google AI Studio API key, when `MODEL_PROVIDER` is `gemini` |
| `ANTHROPIC_API_KEY` | Claude Console API key, when `MODEL_PROVIDER` is `anthropic` |
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

## The agent runs the money (plan 4)

Two agents run each order: the order agent talks to the host, and the treasury agent decides how money leaves the wallet. Every decision is public at `/log` (numbers at `/api/metrics`).

The workflow:
1. Quote.
2. Deposit on Arc. The treasury agent moves the printer's cost to your payout account.
3. You book and pay the printer by card, then send `/printed <order>` in Telegram.
4. The balance request goes to the host.
5. The balance is paid.
6. The host presses "We received it".
7. The treasury agent sweeps part of the margin to the reserve.

Setup:
- **Migration first.** Apply migration 0004 remotely BEFORE `wrangler deploy`: `npx wrangler d1 migrations apply swagpay --remote`. The new code reads tables that don't exist until then.
- **Receiving address.** `RECEIVING_ADDRESS` is your Circle agent wallet on Arc (`circle wallet list --type agent --chain ARC`).
- **Spending limits.** Set them with an email OTP, so the agent can never exceed them:

      circle wallet limit set --address <wallet> --chain ARC --policy-type stablecoin --per-tx 500 --daily 1500

  - This transfer limit is the backstop the treasury relies on.
  - Circle allows only ONE stablecoin policy per wallet and chain (`circle wallet limit set --help`: "If a policy already exists for the same wallet/chain/policy-type, the request will fail"). A recipient allowlist (`--rule-type recipient-allowlist --targets [addr1,addr2]`) would replace the transfer limit, not add to it, so don't set one.
  - Spending limits only exist on mainnet; the CLI refuses testnet chains.
- **Payout account.**
  - `PAYOUT_ADDRESS` and `PAYOUT_CHAIN` are where printer costs go. For example, your Revolut USDC deposit address on Polygon with `PAYOUT_CHAIN=MATIC`: payouts then bridge with CCTP's forwarding service, with no gas needed on Polygon.
  - Use `ARC` for an Arc address.
- **Reserve.** `RESERVE_ADDRESS` is where reserve sweeps go, on Arc.
- **Code limits.** `TREASURY_PER_TX_USDC`, `TREASURY_DAILY_USDC` and `TREASURY_RESERVE_MIN_BPS`/`MAX_BPS` are the code limits. Keep them at or below Circle's. Above them the agent asks you in Telegram.
- **Runner token.** `wrangler secret put TREASURY_RUNNER_TOKEN` (a long random string).
- **Runner.** Run it on the machine where `circle wallet login` is active (the session lasts about four weeks):

      SWAGPAY_URL=https://<your-domain> TREASURY_RUNNER_TOKEN=<token> AGENT_WALLET_ADDRESS=<wallet> DRY_RUN=1 node scripts/treasury-runner.mjs

  - Drop `DRY_RUN=1` once the printed commands look right.
  - Run exactly one runner.
  - `AGENT_WALLET_ADDRESS` must be the same wallet as `RECEIVING_ADDRESS`: the treasury reads that balance.
  - When Circle's limit refuses a payout, you get an approval request in Telegram.
  - When the `circle` login session expires (about four weeks), every payout comes back failed: log in again.
- **Refunds.** Refunds always wait for your approval.
- **EUR (EURC) orders.** The treasury only pays USDC; printer costs for EUR orders come to you to pay by hand.
- **Approve or reject.** On a payout question in Telegram, approve lets the treasury agent pay it (USDC only); reject means you handle it yourself, and the obligation is marked settled.

### Before real money

1. **Rehearse on testnet.** Put the Worker and the wallet on testnet, not only the runner. Use a separate, empty D1 database with all migrations applied, and set:
   - `ARC_CHAIN_ID=5042002`, `ARC_RPC_URL` (and `ARC_RPC_FALLBACK_URL`, if set) to testnet RPCs, and the testnet `EURC_ADDRESS` (see "Payments and quotes" above);
   - `RECEIVING_ADDRESS` to a testnet agent wallet;
   - `PAYOUT_CHAIN=MATIC-AMOY` with a Polygon Amoy `PAYOUT_ADDRESS`, or `PAYOUT_CHAIN=ARC` with an Arc testnet address. Use `ARC`, not `ARC-TESTNET`: the runner's `CIRCLE_CHAIN` picks the network;
   - `RESERVE_ADDRESS` to an Arc testnet address.

   Run the runner with `CIRCLE_CHAIN=ARC-TESTNET DRY_RUN=1` first. Read the printed commands, then drop `DRY_RUN`.
2. **Check idempotency.** On testnet, run each command below twice with the same key. The wallet history must show one transfer per command:

       circle bridge transfer MATIC-AMOY <your Amoy address> --amount 1 --address <wallet> --chain ARC-TESTNET --idempotency-key <one uuid> --output json
       circle wallet transfer <an Arc testnet address> --token 0x3600000000000000000000000000000000000000 --amount 1 --address <wallet> --chain ARC-TESTNET --idempotency-key <another uuid> --output json

   These are the runner's own commands; the `--token` is its default `USDC_ADDRESS`.
3. **Fee.** A bridge payout burns the amount plus Circle's forwarding fee: `--amount` is what the recipient gets. Check the fee with `circle bridge get-fee MATIC --chain ARC`. Keep a little extra USDC in the wallet: the treasury's balance check counts only the amount.
4. **"Sent".** It means Circle accepted the transfer. Check the first real payouts in the wallet history.
5. **Failures.** A failed or denied payout never retries by itself. It comes to you in Telegram. Check the wallet history before you approve a retry.
6. **Mainnet limit check.** Spending limits only exist on mainnet. Before real orders, set a tiny limit, let one payout go above it, and confirm it comes back as denied in Telegram (not as sent). Then `circle wallet limit reset` and set the real limit: a second `set` on the same wallet and chain fails.
