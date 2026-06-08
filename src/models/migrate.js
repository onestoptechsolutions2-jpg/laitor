'use strict';

/**
 * Database migration script.
 * Runs on every container start via docker-entrypoint.sh.
 * All statements use CREATE/ALTER IF NOT EXISTS — safe to re-run.
 *
 * Tables:
 *   customers      — contact records (WhatsApp, import, web)
 *   leads          — sales pipeline entries
 *   orders         — product/service orders
 *   tickets        — support tickets
 *   messages       — full in/out message log
 *   catalog_cache  — local copy of Manager.io inventory + manual items
 *   agents         — team members assigned to categories (internet/products/support/finance)
 *   categories     — product/service categories with Manager.io group mapping
 *   quotes         — customer quotes pending approval
 *   sync_queue     — retry queue for failed CRM/finance pushes
 */

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://laitor:laitor2024@laitor_db:5432/laitor';

console.log('[migrate] Connecting to:', DATABASE_URL.replace(/:([^:@]+)@/, ':***@'));

const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 10000 });

const schema = `
/* ── Core customer/contact table ── */
CREATE TABLE IF NOT EXISTS customers (
  id              SERIAL PRIMARY KEY,
  phone           VARCHAR(20) UNIQUE NOT NULL,
  name            VARCHAR(255),
  location        VARCHAR(255),
  tags            TEXT[],
  crm_id          VARCHAR(255),
  manager_key     VARCHAR(255),
  consent_status  VARCHAR(20)  DEFAULT 'pending',
  consented_at    TIMESTAMPTZ,
  source          VARCHAR(50)  DEFAULT 'inbound',
  cluster         VARCHAR(255),
  territory       VARCHAR(255),
  service_tag     VARCHAR(255),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

/* ── Sales leads (CRM pipeline entries) ── */
CREATE TABLE IF NOT EXISTS leads (
  id          SERIAL PRIMARY KEY,
  customer_id INT REFERENCES customers(id),
  type        VARCHAR(50) NOT NULL,
  status      VARCHAR(50) DEFAULT 'new',
  notes       TEXT,
  crm_lead_id VARCHAR(255),
  source      VARCHAR(50) DEFAULT 'whatsapp',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

/* ── Product / service orders ── */
CREATE TABLE IF NOT EXISTS orders (
  id              SERIAL PRIMARY KEY,
  customer_id     INT REFERENCES customers(id),
  product         VARCHAR(255),
  status          VARCHAR(50)  DEFAULT 'pending',
  supplier_status VARCHAR(50)  DEFAULT 'pending',
  notes           TEXT,
  invoice_ref     VARCHAR(255),
  quote_id        INT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

/* ── Support tickets ── */
CREATE TABLE IF NOT EXISTS tickets (
  id             SERIAL PRIMARY KEY,
  customer_id    INT REFERENCES customers(id),
  issue          TEXT NOT NULL,
  priority       VARCHAR(20)  DEFAULT 'medium',
  status         VARCHAR(50)  DEFAULT 'open',
  technician     VARCHAR(255),
  agent_id       INT,
  crm_ticket_id  VARCHAR(255),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

/* ── Message audit log (in + out) ── */
CREATE TABLE IF NOT EXISTS messages (
  id         SERIAL PRIMARY KEY,
  phone      VARCHAR(20) NOT NULL,
  direction  VARCHAR(10) NOT NULL,
  text       TEXT,
  raw        JSONB,
  msg_id     VARCHAR(255) UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

/* ── Catalog cache (Manager.io + manual entries) ── */
CREATE TABLE IF NOT EXISTS catalog_cache (
  id          SERIAL PRIMARY KEY,
  item_key    VARCHAR(255) UNIQUE NOT NULL,
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  price       DECIMAL(10,2) DEFAULT 0,
  type        VARCHAR(50)   DEFAULT 'product',
  category_id INT,
  raw         JSONB,
  cached_at   TIMESTAMPTZ DEFAULT NOW()
);

/* ── Team agents — one per category ── */
CREATE TABLE IF NOT EXISTS agents (
  id                SERIAL PRIMARY KEY,
  name              VARCHAR(255) NOT NULL,
  phone             VARCHAR(20)  UNIQUE NOT NULL,
  email             VARCHAR(255),
  categories        TEXT[]       DEFAULT '{}',
  escalation_phone  VARCHAR(20),
  active            BOOLEAN      DEFAULT true,
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

/* ── Product/service categories ── */
CREATE TABLE IF NOT EXISTS categories (
  id                  SERIAL PRIMARY KEY,
  name                VARCHAR(255) UNIQUE NOT NULL,
  slug                VARCHAR(100) UNIQUE NOT NULL,
  manager_group_key   VARCHAR(255),
  display_order       INT          DEFAULT 0,
  active              BOOLEAN      DEFAULT true,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

/* ── Quotes awaiting customer approval ── */
CREATE TABLE IF NOT EXISTS quotes (
  id            SERIAL PRIMARY KEY,
  customer_id   INT REFERENCES customers(id),
  order_id      INT REFERENCES orders(id),
  manager_quote_ref  VARCHAR(255),
  status        VARCHAR(50)   DEFAULT 'draft',
  items         JSONB         NOT NULL DEFAULT '[]',
  total_amount  DECIMAL(10,2) DEFAULT 0,
  currency      VARCHAR(10)   DEFAULT 'KES',
  notes         TEXT,
  sent_at       TIMESTAMPTZ,
  approved_at   TIMESTAMPTZ,
  declined_at   TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

/* ── Sync retry queue (failed CRM / Manager.io pushes) ── */
CREATE TABLE IF NOT EXISTS sync_queue (
  id            SERIAL PRIMARY KEY,
  entity_type   VARCHAR(50)  NOT NULL,
  entity_id     VARCHAR(255) NOT NULL,
  target        VARCHAR(50)  NOT NULL,
  payload       JSONB        NOT NULL,
  status        VARCHAR(20)  DEFAULT 'pending',
  attempts      INT          DEFAULT 0,
  last_error    TEXT,
  next_retry_at TIMESTAMPTZ  DEFAULT NOW(),
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW()
);

/* ── Safe column additions for existing installs ── */
ALTER TABLE customers ADD COLUMN IF NOT EXISTS consent_status  VARCHAR(20)  DEFAULT 'pending';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS consented_at    TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS source          VARCHAR(50)  DEFAULT 'inbound';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS cluster         VARCHAR(255);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS territory       VARCHAR(255);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS service_tag     VARCHAR(255);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS manager_key     VARCHAR(255);
ALTER TABLE orders    ADD COLUMN IF NOT EXISTS invoice_ref     VARCHAR(255);
ALTER TABLE orders    ADD COLUMN IF NOT EXISTS quote_id        INT;
ALTER TABLE tickets   ADD COLUMN IF NOT EXISTS agent_id        INT;
ALTER TABLE catalog_cache ADD COLUMN IF NOT EXISTS category_id INT;


/* ── Bot configuration (editable from admin dashboard) ── */
CREATE TABLE IF NOT EXISTS bot_config (
  id         SERIAL PRIMARY KEY,
  key        VARCHAR(100) UNIQUE NOT NULL,
  value      TEXT         NOT NULL,
  updated_at TIMESTAMPTZ  DEFAULT NOW()
);

/* ── WhatsApp main menu items (editable from admin dashboard) ── */
CREATE TABLE IF NOT EXISTS menu_items (
  id            SERIAL PRIMARY KEY,
  label         VARCHAR(100) NOT NULL,
  description   VARCHAR(255),
  icon          VARCHAR(10)  DEFAULT '📌',
  action        VARCHAR(50)  NOT NULL,
  display_order INT          DEFAULT 0,
  active        BOOLEAN      DEFAULT true,
  created_at    TIMESTAMPTZ  DEFAULT NOW()
);

/* ── Seed default menu items ── */
INSERT INTO menu_items (label, description, icon, action, display_order) VALUES
  ('Internet Packages',    'Browse our internet plans',         '📶', 'INTERNET_BROWSE', 1),
  ('Products & Equipment', 'CCTV, routers, networking gear',    '📦', 'PRODUCT_BROWSE',  2),
  ('Technical Support',    'Report an issue or fault',          '🔧', 'SUPPORT_AWAIT',   3),
  ('Speak to an Agent',    'Get help from our team directly',   '👤', 'AGENT_HANDOFF',   4)
ON CONFLICT DO NOTHING;

/* ── Indexes ── */
CREATE INDEX IF NOT EXISTS idx_customers_phone      ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_consent    ON customers(consent_status);
CREATE INDEX IF NOT EXISTS idx_customers_source     ON customers(source);
CREATE INDEX IF NOT EXISTS idx_messages_phone       ON messages(phone);
CREATE INDEX IF NOT EXISTS idx_messages_msg_id      ON messages(msg_id);
CREATE INDEX IF NOT EXISTS idx_leads_customer       ON leads(customer_id);
CREATE INDEX IF NOT EXISTS idx_tickets_customer     ON tickets(customer_id);
CREATE INDEX IF NOT EXISTS idx_catalog_type         ON catalog_cache(type);
CREATE INDEX IF NOT EXISTS idx_quotes_customer      ON quotes(customer_id);
CREATE INDEX IF NOT EXISTS idx_quotes_status        ON quotes(status);
CREATE INDEX IF NOT EXISTS idx_sync_queue_status    ON sync_queue(status);
CREATE INDEX IF NOT EXISTS idx_sync_queue_retry     ON sync_queue(next_retry_at);

/* ── Seed default categories if empty ── */
INSERT INTO categories (name, slug, display_order) VALUES
  ('Internet Packages',    'internet',  1),
  ('Products & Equipment', 'products',  2),
  ('Technical Support',    'support',   3)
ON CONFLICT (slug) DO NOTHING;
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
