CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft',
  event_name TEXT NOT NULL,
  event_date TEXT NOT NULL,
  deliver_by TEXT NOT NULL,
  delivery_place TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  spec_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  tool TEXT NOT NULL,
  reason TEXT NOT NULL,
  input_json TEXT NOT NULL,
  verdict TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX decisions_by_order ON decisions(order_id, id);
CREATE INDEX orders_by_created ON orders(created_at);
