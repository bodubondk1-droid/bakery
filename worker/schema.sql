-- Sokkary juice shop database (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  name TEXT NOT NULL UNIQUE,
  price INTEGER NOT NULL CHECK (price >= 0),
  image_url TEXT,            -- path of a bundled image, e.g. images/j-mango.jpg
  image_data TEXT,           -- uploaded image as a data: URL; wins over image_url
  available INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  address TEXT,
  orders_count INTEGER NOT NULL DEFAULT 0,
  total_spent INTEGER NOT NULL DEFAULT 0,
  first_order_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_order_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER REFERENCES customers(id),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  payment TEXT NOT NULL,
  items TEXT NOT NULL,       -- JSON: [{ "name", "qty", "price" }]
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'preparing', 'delivered', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS orders_created ON orders (created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- WhatsApp Business API inbound messages
CREATE TABLE IF NOT EXISTS wa_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_message_id TEXT UNIQUE,                -- WhatsApp message ID for dedup
  from_number TEXT NOT NULL,                -- sender phone, e.g. "201060063622"
  profile_name TEXT,                        -- sender's WhatsApp display name
  msg_type TEXT NOT NULL DEFAULT 'text',    -- text, image, audio, etc.
  content TEXT,                             -- message body (text only)
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
