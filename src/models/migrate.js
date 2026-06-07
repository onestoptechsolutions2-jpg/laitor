'use strict';

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://laitor:laitor2024@laitor_db:5432/laitor';

console.log('[migrate] Connecting to:', DATABASE_URL.replace(/:([^:@]+)@/, ':***@'));

const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 10000 });

const schema = `
CREATE TABLE IF NOT EXISTS customers (
  id              SERIAL PRIMARY KEY,
  phone           VARCHAR(20) UNIQUE NOT NULL,
  name            VARCHAR(255),
  location        VARCHAR(255),
  tags            TEXT[],
  crm_id          VARCHAR(255),
  consent_status  VARCHAR(20) DEFAULT 'pending',
  consented_at    TIMESTAMPTZ,
  source          VARCHAR(50) DEFAULT 'inbound',
  cluster         VARCHAR(255),
  territory       VARCHAR(255),
  service_tag     VARCHAR(255),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
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
CREATE TABLE IF NOT EXISTS catalog_cache (
  id          SERIAL PRIMARY KEY,
  item_key    VARCHAR(255) UNIQUE NOT NULL,
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  price       DECIMAL(10,2) DEFAULT 0,
  type        VARCHAR(50) DEFAULT 'product',
  raw         JSONB,
  cached_at   TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS consent_status  VARCHAR(20) DEFAULT 'pending';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS consented_at   TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS source         VARCHAR(50) DEFAULT 'inbound';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS cluster        VARCHAR(255);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS territory      VARCHAR(255);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS service_tag    VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_customers_phone     ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_consent   ON customers(consent_status);
CREATE INDEX IF NOT EXISTS idx_messages_phone      ON messages(phone);
CREATE INDEX IF NOT EXISTS idx_messages_msg_id     ON messages(msg_id);
CREATE INDEX IF NOT EXISTS idx_leads_customer      ON leads(customer_id);
CREATE INDEX IF NOT EXISTS idx_tickets_customer    ON tickets(customer_id);
CREATE INDEX IF NOT EXISTS idx_catalog_type        ON catalog_cache(type);
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
