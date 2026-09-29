# Swagpay

Event swag (t-shirts and stickers) printed by local printers and paid in USDC or EURC on Arc.
An AI agent runs each order. Design: `docs/design.md`.

## Develop

    npm install
    npm run types
    npm test
    echo 'ANTHROPIC_API_KEY=sk-ant-...' > .dev.vars
    npm run dev
