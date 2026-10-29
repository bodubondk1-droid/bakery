-- 2026-10-29, counter screen: adds the "out for delivery" status and paid_at (when a
-- Vodafone Cash / Instapay transfer was confirmed).
-- SQLite can't change a CHECK constraint in place, so the orders table is rebuilt with the
-- same rows and ids. Run on both databases, sokkary-db and sokkary-backup:
--   npx wrangler d1 execute sokkary-db --remote --file migrations/2026-10-29-counter.sql
--   npx wrangler d1 execute sokkary-backup --remote --file migrations/2026-10-29-counter.sql
-- The orders table in Supabase needs the same: a paid_at column and the new status allowed.

PRAGMA defer_foreign_keys = true;

CREATE TABLE orders_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER REFERENCES customers(id),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  payment TEXT NOT NULL,
  items TEXT NOT NULL,
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'preparing', 'out_for_delivery', 'delivered', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at TEXT
);

INSERT INTO orders_new (id, customer_id, name, phone, address, payment, items, total, status, created_at)
  SELECT id, customer_id, name, phone, address, payment, items, total, status, created_at FROM orders;

DROP TABLE orders;
ALTER TABLE orders_new RENAME TO orders;
CREATE INDEX IF NOT EXISTS orders_created ON orders (created_at DESC);
