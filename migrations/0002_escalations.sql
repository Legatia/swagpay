CREATE TABLE escalations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER REFERENCES orders(id),
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  decision_note TEXT,
  telegram_message_id INTEGER,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  delivered_at TEXT
);

CREATE INDEX escalations_by_status ON escalations(status, id);
CREATE INDEX escalations_by_order ON escalations(order_id);
