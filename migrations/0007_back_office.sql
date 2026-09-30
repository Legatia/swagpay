-- The owner's back office: printer payments made by hand (card, BLIK, transfer), their Kraken cash-outs,
-- an audit of the owner's dashboard actions, the wallet runner's heartbeat, and printer offers (plan 7, task 5).
CREATE TABLE supplier_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  vendor_id INTEGER REFERENCES vendors(id),
  currency TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'due',
  method TEXT,
  reference TEXT,
  note TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX supplier_payments_by_status ON supplier_payments(status, id);

CREATE TABLE cashouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_payment_id INTEGER NOT NULL REFERENCES supplier_payments(id),
  fiat TEXT NOT NULL,
  fiat_cents INTEGER NOT NULL,
  client_order_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued',
  sold_units INTEGER,
  order_ref TEXT,
  withdrawal_ref TEXT,
  fee_cents INTEGER,
  withdraw_attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- One live cash-out per printer payment: a double click or a retry can't sell twice.
CREATE UNIQUE INDEX cashouts_one_live ON cashouts(supplier_payment_id) WHERE status IN ('queued', 'sold');

CREATE TABLE admin_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE runner_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE printer_offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  currency TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  delivery_cents INTEGER NOT NULL DEFAULT 0,
  other_cents INTEGER NOT NULL DEFAULT 0,
  arrives_at TEXT NOT NULL,
  note TEXT,
  chosen_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX printer_offers_by_order ON printer_offers(order_id, id);

ALTER TABLE vendors ADD COLUMN pay_currency TEXT;
ALTER TABLE vendors ADD COLUMN how_to_pay TEXT;
