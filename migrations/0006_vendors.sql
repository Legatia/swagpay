-- Printers per city (the vendors), each order's printer job, and which obligations pay a vendor.
CREATE TABLE vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  country TEXT NOT NULL,
  methods TEXT NOT NULL,
  email TEXT,
  website TEXT,
  tax_id_type TEXT,
  tax_id TEXT,
  tax_status TEXT,
  tax_checked_at TEXT,
  lead_days TEXT,
  lat REAL,
  lng REAL,
  status TEXT NOT NULL DEFAULT 'candidate',
  payout_address TEXT,
  payout_chain TEXT,
  source_ref TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX vendors_by_city ON vendors(city, status);

CREATE TABLE vendor_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  status TEXT NOT NULL DEFAULT 'proposed',
  cost_currency TEXT NOT NULL,
  cost_cents INTEGER NOT NULL,
  deliver_by TEXT NOT NULL,
  booked_at TEXT,
  printed_at TEXT,
  delivered_at TEXT,
  on_time INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX vendor_jobs_by_vendor ON vendor_jobs(vendor_id, status);

ALTER TABLE obligations ADD COLUMN vendor_id INTEGER REFERENCES vendors(id);
