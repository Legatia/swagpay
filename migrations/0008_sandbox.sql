-- Sandbox only (sandbox.swagpay.me). Production has these tables too, empty: migrations are shared.
-- The mock bank's ledger: one row per cash-out step, never repeated (idempotency per client order id).
CREATE TABLE sandbox_bank_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cashout_id INTEGER NOT NULL,
  client_order_id TEXT NOT NULL,
  step TEXT NOT NULL,
  fiat TEXT,
  fiat_cents INTEGER,
  usdc_units INTEGER,
  rate REAL,
  ref TEXT,
  account_masked TEXT,
  tx_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX sandbox_bank_step ON sandbox_bank_ledger(client_order_id, step);

-- The in-Worker runner's sends: a payout's idempotency key is claimed before broadcasting, so a retry never sends twice.
CREATE TABLE sandbox_runner_sends (
  idempotency_key TEXT PRIMARY KEY,
  payout_id INTEGER NOT NULL,
  tx_hash TEXT,
  created_at TEXT NOT NULL
);
