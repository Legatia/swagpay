-- Idempotent order creation: a retried create with the same key returns the same order for 24 hours.
-- token stays null while the first create is still running. The plain token is kept only for that window,
-- because order tokens are otherwise stored hashed and a replay must return the original link.
CREATE TABLE order_create_keys (
  key TEXT PRIMARY KEY,
  body_hash TEXT NOT NULL,
  order_id INTEGER REFERENCES orders(id),
  token TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX order_create_keys_by_created ON order_create_keys(created_at);
