# Swagpay: design (2026-09-29)

Swagpay sells event swag (t-shirts and stickers first) to crypto event hosts. Hosts and their
sponsors pay in USDC or EURC on Arc, from any chain. A local Warsaw printer makes the goods and
they are delivered to the venue. An AI agent runs each order; the owner's only routine step is
paying the printer by card. Swagpay is the owner's Tameion hackathon entry (RFB 03 lead, RFB 04
support). Shareable overview: https://claude.ai/artifact/7V3E3RCbvA7W7W769m4z3N

## Understanding (agreed 2026-09-29)

Said by the owner:
- Pilot at the weekly events at Kolektyw3 (Koszykowa 54, Warsaw). T-shirts and stickers first;
  banners on request.
- Cross-border payment is central: sponsors anywhere pay; the printer is paid in złoty.
- The owner pays printers by card during the pilot.
- Hosts talk to the agent on the order page and in Telegram.
- Printers are contacted by email (Warsaw shops publish no ordering APIs; Gelato was declined).
- Stack: Cloudflare Workers with the Agents SDK.
- Build the pieces one by one, carefully, with no fixed calendar.

Assumed:
- One operator (the owner), fewer than about ten orders a week, one to three Warsaw printers.
- No customer accounts; an order is reached by its private link.
- Real mainnet USDC and EURC on Arc.

Success: a real order runs from request to delivery, the agent's decisions are logged with
reasons, payments are detected on Arc without a human, and the code is in a public repo.

## Out of scope

- REGI in any form, and anything to do with Registrai's markets.
- Printing APIs (Gelato, Printful) and browser automation of printer websites.
- Currencies other than USDC and EURC (partner stablecoins such as GBPA and JPYC come later).
- Paying printers in crypto, and automated USDC-to-złoty conversion (the owner's card pays).
- Invoicing and VAT treatment: decided with an accountant later. The system records every
  printer cost net and gross so any treatment can be applied.

## Architecture

One Cloudflare Worker named `swagpay`, TypeScript, in its own git repo (`~/Desktop/arc/swagpay`,
published as a public GitHub repo `swagpay`).

| Part | What it is | Responsibility |
|---|---|---|
| Site | Static assets served by the Worker | Landing page, new-order form, order page `/o/<token>`, public log `/log`, admin `/admin` |
| API | `fetch` handler routes | JSON endpoints the site calls; Telegram webhook |
| `OrderAgent` | Agents SDK class, one instance per order | Order state, the conversation, the Claude tool loop, per-order schedules (chasers, deadlines) |
| Email | `email` handler + Email Routing | Printer replies to `OrderAgent+<orderId>@<domain>` go to that order's agent |
| Cron | `scheduled` handler | Arc payment watcher (every minute); PLN rate refresh (hourly) |
| D1 | SQL database | Cross-order data: orders index, printers, payment requests, payments, decisions, escalations |
| Telegram | Bot API webhook | Host chat per order; owner admin chat with Approve and Reject buttons |
| Claude | Anthropic API, `claude-sonnet-5-5` (Claude Sonnet 5.5) by default (config) | The agent's decisions, including looking at artwork and proof photos |

Order conversation and working state live in the `OrderAgent` instance (its SQLite). Anything
read across orders or shown publicly lives in D1.

### Configuration (Worker vars and secrets)

- `ARC_RPC_URL` (default `https://rpc.blockdaemon.mainnet.arc.io`), `ARC_RPC_FALLBACK_URL`
  (an Alchemy Arc endpoint with a free key), `ARC_CHAIN_ID` (5042). The official
  `rpc.mainnet.arc.io` and QuickNode's keyless endpoint rate-limit `eth_getLogs` from
  Cloudflare's shared IPs (429 on the first call); Blockdaemon's keyless endpoint answers. See
  `event-swag/rpc-spike.md` (2026-09-29).
- `USDC_ADDRESS` `0x3600000000000000000000000000000000000000`, `EURC_ADDRESS`
  `0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1` (both 6 decimals)
- `RECEIVING_ADDRESS`: the Arc address of the owner's Circle agent wallet
- `ANTHROPIC_API_KEY`, `MODEL` (default `claude-sonnet-5-5`)
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_OWNER_CHAT_ID`
- `EMAIL_SECRET` (signs outbound printer mail so forged replies are rejected), `EMAIL_FROM`
- `POLICY_*` overrides (below)

The testnet rehearsal uses the same code with Arc testnet values (chain 5042002, EURC
`0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`).

## Policy (code, not prompt)

`src/policy.ts` holds every limit. The model can only choose inside it; each check returns
`allow`, `block` (with a reason the model sees) or `escalate`.

| Rule | Default | Effect |
|---|---|---|
| Allowed items | t-shirt (screen, DTF, DTG), die-cut sticker | Anything else escalates |
| Markup over printer cost (gross, incl. delivery) | 40% to 50% | Outside the band blocks |
| Per-order cap | 1,000 USD | Above it escalates |
| Deposit | the larger of 50% of the price and the printer cost (with the FX buffer, in the quote currency) | The owner never fronts printer cost (decided by the owner 2026-09-29) |
| FX buffer on quotes | 3% | Added to the PLN cost converted at the current rate |
| Quote validity | 48 hours | After that, or if PLN moved past the buffer, re-quote |
| Minimum lead time | stickers 2 business days, DTF or DTG 2, screen print 4 | A shorter deadline escalates |
| New printer | first job with any printer | Escalates |
| Printer payment | every order | Always escalates (the owner pays) |
| Refund | every refund | Escalates; the owner sends it with `circle wallet transfer` under the Circle spending cap |

Defaults are starting values; the owner tunes them after the first printer quotes.

## Order lifecycle

States: `draft → quoted → deposit_pending → deposit_paid → printer_selected → printer_paid →
in_production → proof_ok → balance_pending → balance_paid → delivered → closed`, plus
`cancelled` and `refunding`. Only code moves the state, and only after the matching tool call
passed policy or the owner approved an escalation.

1. **Intake.** The host fills in the form (event, date, delivery place, items, sizes, artwork,
   contact). An order and its `OrderAgent` are created; the host gets the private link and a
   Telegram start link.
2. **Clarify.** The agent asks for anything missing (size split, artwork file, colours) and
   checks the artwork is printable.
3. **Quote.** The agent picks the print method, checks lead time, requests quotes from screened
   printers by email, records their replies, and proposes a price in USD or EUR to the host.
4. **Deposit.** Deposit payment requests (the larger of 50% of the price and the printer cost) are
   created, one or one per sponsor. The watcher confirms payment on Arc.
5. **Printer.** The agent picks a printer and a backup from the quotes it collected in step 3.
6. **Printer paid.** Escalation to the owner with the PLN amount and the printer's verified bank
   account. The owner pays and approves; the rate is logged. The agent then sends the job and
   artwork to the printer.
7. **Proof.** The printer emails a photo; the agent compares it with the order.
8. **Balance.** The rest of the price is requested and confirmed on Arc.
9. **Delivery.** Delivered to the venue; the host confirms and rates; the printer's score updates.

## Agent tools

Every tool takes a required `reason` string. Code writes one `decisions` row per call with the
tool, the reason, the input, the policy result and the outcome.

| Tool | Does | Policy |
|---|---|---|
| `ask_host` | Posts a message to the order conversation (page and Telegram) | none |
| `update_order` | Sets the structured order: items, method, sizes, quantities, deadline, place | allowed items |
| `check_artwork` | Model looks at an uploaded file; records issues | none |
| `screen_printer` | Checks a printer by NIP against the VAT taxpayer list (status, name, address, bank accounts) and KRS where applicable | none |
| `request_printer_quotes` | Emails a quote request to chosen printers | printer must be screened |
| `record_printer_quote` | Stores a price parsed from a printer's reply | none |
| `send_quote` | Sends the host the price and breakdown | markup band, per-order cap, lead time |
| `create_payment_requests` | Creates deposit or balance requests, optionally split by sponsor | amounts must sum to the stage total |
| `choose_printer` | Picks the printer and a backup | new printer escalates |
| `request_printer_payment` | Asks the owner to pay the printer | always escalates |
| `send_print_job` | Emails the job and artwork to the chosen printer | printer payment approved |
| `check_proof` | Model compares the proof photo with the order | none |
| `confirm_delivery` | Marks delivered after the host confirms | none |
| `rate_printer` | Records delivery time and host rating | none |
| `draft_refund` | Prepares a refund for the owner | always escalates |
| `escalate` | Anything else the agent wants a human for | always escalates |

The agent runs when something happens: a host message, a printer email, a payment, an owner
decision, or a scheduled chaser. Each run is one Claude tool loop (maximum 12 tool calls) that
ends with the agent waiting for the next event.

## Payments

- Payment requests hold token (USDC or EURC), amount and a unique tag: the amount's last four
  of six decimals identify the request (for example 412.370042). Tags are unique among open
  requests.
- **On the order page:** the payer connects a wallet and pays on Arc directly, or from another
  chain with Circle App Kit Bridge (standard transfer, free) to `RECEIVING_ADDRESS`. The page
  posts the transaction hash to the API; the watcher confirms the transfer landed.
- **Plain transfers:** matched by the unique amount.
- **Watcher:** every minute, reads `Transfer` logs of USDC and EURC to `RECEIVING_ADDRESS` since
  the last processed block (stored in D1), matches each to a request by reported hash or unique
  amount, and wakes that order's agent. A transfer that matches nothing opens an escalation.
  Each `eth_getLogs` call filters by both token addresses and by the recipient topic, and
  catch-up after downtime runs in chunks of 5,000 blocks (the official RPC caps a call at 10,000;
  Arc makes about 1.6 blocks a second). On repeated errors the watcher switches to
  `ARC_RPC_FALLBACK_URL`.
- **The order page warns payers** to send the exact amount: exchanges that deduct a withdrawal
  fee leave a remainder, which then shows as still due.
- A payment is keyed by transaction hash and log index, so it is never counted twice.
- Underpayment keeps the request open with the remainder shown; overpayment records the
  surplus and the agent drafts a refund.

## Printers and email

- Printers are rows in D1 (name, NIP, email, phone, address, methods, lead times, price notes,
  VAT status and bank accounts with the check date, score, jobs done, jobs late). The first rows
  are seeded from research done outside the product.
- The domain is the one the owner registers for Swagpay (swagpay.xyz or swagpay.app), on
  Cloudflare so Email Routing and Access work.
- Outbound mail comes from the order's address so replies route back to its agent, and is signed
  with `EMAIL_SECRET`. Delivery uses Cloudflare Email Sending if the account has it; otherwise
  Resend. The first build step checks which.
- A printer that does not reply within 8 working hours gets one chaser; after 16, the agent
  moves to the backup printer.
- When a printer is paid by bank transfer, the account on the invoice must be one of that
  printer's accounts on the VAT list; a mismatch blocks and escalates. Card payments skip this
  check.

## Owner queue

- An `escalations` row per item (kind, summary, payload, status, decision, time).
- Each escalation is sent to the owner's Telegram chat with Approve and Reject buttons (and a
  note field for amounts, for example the PLN actually paid).
- `/admin` lists open and past escalations and the orders; it sits behind Cloudflare Access.

## Hosts in Telegram

- The order page shows a `t.me/<bot>?start=<link code>` link. Starting the bot binds that chat to
  the order. Messages from the chat go to the order's conversation, and the agent's messages are
  sent to both the page and the chat.
- A chat can be bound to several orders; the bot asks which one when that is ambiguous.

## Public decision log

`/log` lists decisions across orders, newest first: time, order number, tool, reason, outcome.
It never shows contact details, emails, addresses, amounts paid by named people or bank data.

## Error handling

- Claude API errors: retry with backoff (3 attempts), then an escalation "agent could not run".
- Tool input that fails validation returns an error to the model, which can correct it.
- Email send failures retry, then escalate.
- The watcher is idempotent and resumes from the last processed block after any failure.
- Order text never changes policy; a blocked tool call is logged with its reason.

## Testing

- Unit tests (Vitest with the Workers pool): policy checks, unique-amount tags, payment
  matching, state transitions, each tool handler with Claude mocked, email signing and routing.
- Watcher tests against recorded Arc logs.
- A full rehearsal on Arc testnet with testnet USDC and EURC before any mainnet order.

## Build order

Each step is built, tested and reviewed before the next starts.

1. Repo, Worker skeleton, D1 schema, `policy.ts` with tests.
2. Intake: form, order page, conversation, `OrderAgent` with the Claude loop and the host tools.
3. Owner queue: escalations, Telegram admin chat, `/admin`.
4. Payments: requests, unique tags, watcher, deposit flow.
5. Printers: screening, quote requests by email, inbound mail, printer choice, job, proof.
6. Balance, delivery and rating.
7. Hosts in Telegram.
8. Paying from other chains with App Kit Bridge, and sponsor splits.
9. Public decision log.
10. Testnet rehearsal, then the first mainnet order.
