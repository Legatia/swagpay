-- Printers the agent finds and how they were checked, the printers it asks for quotes, and soft limits on clients and model calls.
ALTER TABLE vendors ADD COLUMN found_by TEXT NOT NULL DEFAULT 'research';
ALTER TABLE vendors ADD COLUMN registered_name TEXT;
ALTER TABLE vendors ADD COLUMN evidence TEXT;
CREATE INDEX vendors_by_tax_id ON vendors(tax_id);

CREATE TABLE discoveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city_key TEXT NOT NULL,
  city TEXT NOT NULL,
  order_id INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  found INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  searches INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT
);
CREATE INDEX discoveries_by_city ON discoveries(city_key, started_at);
CREATE INDEX discoveries_by_order ON discoveries(order_id);
CREATE INDEX discoveries_by_start ON discoveries(started_at);

CREATE TABLE quote_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  escalation_id INTEGER NOT NULL,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  status TEXT NOT NULL,
  offer_id INTEGER,
  decline_reason TEXT,
  notified_at TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT,
  UNIQUE (escalation_id, vendor_id)
);
CREATE INDEX quote_requests_by_order ON quote_requests(order_id);

CREATE TABLE client_orders (
  day TEXT NOT NULL,
  client TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (day, client)
);

CREATE TABLE model_calls_daily (
  day TEXT PRIMARY KEY,
  n INTEGER NOT NULL
);
