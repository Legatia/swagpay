CREATE TABLE fx_rates (
  code TEXT PRIMARY KEY,
  pln_per_unit REAL NOT NULL,
  effective_date TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  currency TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  deposit_cents INTEGER NOT NULL,
  cost_pln_grosze INTEGER NOT NULL,
  pln_per_unit REAL NOT NULL,
  usd_per_unit REAL NOT NULL,
  markup REAL NOT NULL,
  items_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  issued_at TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  accepted_at TEXT
);
CREATE INDEX quotes_by_order ON quotes(order_id, id);

CREATE TABLE payment_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  quote_id INTEGER NOT NULL REFERENCES quotes(id),
  stage TEXT NOT NULL,
  token TEXT NOT NULL,
  amount_units INTEGER NOT NULL,
  tag INTEGER NOT NULL,
  paid_units INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  due_by TEXT NOT NULL,
  paid_at TEXT
);
CREATE UNIQUE INDEX payment_requests_open_tag ON payment_requests(token, tag) WHERE status = 'open';
CREATE INDEX payment_requests_by_order ON payment_requests(order_id);

CREATE TABLE payment_claims (
  tx_hash TEXT PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES payment_requests(id),
  created_at TEXT NOT NULL
);

CREATE TABLE transfers (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  token TEXT NOT NULL,
  from_address TEXT NOT NULL,
  amount_units INTEGER NOT NULL,
  request_id INTEGER REFERENCES payment_requests(id),
  via TEXT,
  notified_at TEXT,
  paid_after INTEGER,
  notify_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);

CREATE TABLE watcher_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
