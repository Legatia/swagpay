-- How each printer offer can be delivered (1-3 options), and which one the offer currently uses.
CREATE TABLE offer_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id INTEGER NOT NULL REFERENCES printer_offers(id),
  method TEXT NOT NULL,
  cost_cents INTEGER NOT NULL,
  arrives_at TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX offer_deliveries_by_offer ON offer_deliveries(offer_id);

ALTER TABLE printer_offers ADD COLUMN delivery_method TEXT;
ALTER TABLE printer_offers ADD COLUMN delivery_id INTEGER;
