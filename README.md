# Swagpay

Event swag (t-shirts and stickers) printed by local printers and paid in USDC or EURC on Arc.
An AI agent runs each order. Design: `docs/design.md`.

## Develop

    npm install
    npm run types
    npm test
    echo 'ANTHROPIC_API_KEY=sk-ant-...' > .dev.vars
    npm run dev

## Deploy (owner)

    npx wrangler d1 create swagpay            # put the printed database_id into wrangler.jsonc
    npx wrangler r2 bucket create swagpay-artwork
    npx wrangler d1 migrations apply swagpay --remote
    npx wrangler secret put ANTHROPIC_API_KEY  # a Claude Console API key
    npm run deploy
