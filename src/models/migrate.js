'use strict';

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://laitor:laitor2024@laitor_db:5432/laitor';

console.log('[migrate] Connecting to:', DATABASE_URL.replace(/:([^:@]+)@/, ':***@'));

const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 10000 });

const schema = `
CREATE TABLE IF NOT EXISTS customers (
  id         SERIAL PRIMARY KEY,
  phone      VARCHAR(20) UNIQUE NOT NULL,
  name       VARCHAR(255),
  location   VARCHAR(255),
  tags       TEXT[],
  crm_id     VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS leads (
  id          SERIAL PRIMARY KEY,
  customer_id INT REFERENCES customers(id),
  type        VARCHAR(50) NOT NULL,
  status      VARCHAR(50) DEFAULT 'new',
  notes       TEXT,
  crm_lead_id VARCHAR(255),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS orders (
  id              SERIAL PRIMARY KEY,
  customer_id     INT REFERENCES customers(id),
  product         VARCHAR(255),
  status          VARCHAR(50) DEFAULT 'pending',
  supplier_status VARCHAR(50) DEFAULT 'pending',
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS tickets (
  id            SERIAL PRIMARY KEY,
  customer_id   INT REFERENCES customers(id),
  issue         TEXT NOT NULL,
  priority      VARCHAR(20) DEFAULT 'medium',
  status        VARCHAR(50) DEFAULT 'open',
  technician    VARCHAR(255),
  crm_ticket_id VARCHAR(255),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS messages (
  id         SERIAL PRIMARY KEY,
  phone      VARCHAR(20) NOT NULL,
  direction  VARCHAR(10) NOT NULL,
  text       TEXT,
  raw        JSONB,
  msg_id     VARCHAR(255) UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_customers_phone  ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_messages_phone   ON messages(phone);
CREATE INDEX IF NOT EXISTS idx_messages_msg_id  ON messages(msg_id);
CREATE INDEX IF NOT EXISTS idx_leads_customer   ON leads(customer_id);
CREATE INDEX IF NOT EXISTS idx_tickets_customer ON tickets(customer_id);
`;

(async () => {
  let client;
  try {
    client = await pool.connect();
    console.log('[migrate] Connected. Applying schema...');
    await client.query(schema);
    console.log('[migrate] Schema applied successfully.');
  } catch (err) {
    console.error('[migrate] FAILED:', err.message);
    console.error('[migrate] Code   :', err.code);
    console.error('[migrate] Detail :', err.detail);
    process.exit(1);
  } finally {
    if (client) client.release();
    await pool.end();
  }
})();
