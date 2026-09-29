-- Money the business owes or moves, and each execution through the Circle agent wallet.
CREATE TABLE obligations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER REFERENCES orders(id),
  kind TEXT NOT NULL,
  token TEXT NOT NULL,
  amount_units INTEGER NOT NULL,
  destination TEXT NOT NULL,
  chain TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  approved_by TEXT,
  source_ref TEXT NOT NULL UNIQUE,
  note TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT
);
CREATE INDEX obligations_by_status ON obligations(status, id);
CREATE INDEX obligations_by_order ON obligations(order_id);

CREATE TABLE payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  obligation_id INTEGER NOT NULL REFERENCES obligations(id),
  method TEXT NOT NULL,
  chain TEXT NOT NULL,
  token TEXT NOT NULL,
  amount_units INTEGER NOT NULL,
  destination TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued',
  result_ref TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX payouts_by_status ON payouts(status, id);
-- An obligation never has two live payouts.
CREATE UNIQUE INDEX payouts_one_live ON payouts(obligation_id) WHERE status IN ('queued', 'sent');

CREATE TABLE treasury_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER REFERENCES orders(id),
  tool TEXT NOT NULL,
  reason TEXT NOT NULL,
  input_json TEXT NOT NULL,
  verdict TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
