'use strict';

/**
 * Database migration script.
 * Runs on every container start via docker-entrypoint.sh.
 * All statements use CREATE/ALTER IF NOT EXISTS — safe to re-run.
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
  id                 SERIAL PRIMARY KEY,
  customer_id        INT REFERENCES customers(id),
  order_id           INT REFERENCES orders(id),
  manager_quote_ref  VARCHAR(255),
  status             VARCHAR(50)   DEFAULT 'draft',
  items              JSONB         NOT NULL DEFAULT '[]',
  total_amount       DECIMAL(10,2) DEFAULT 0,
  currency           VARCHAR(10)   DEFAULT 'KES',
  notes              TEXT,
  sent_at            TIMESTAMPTZ,
  approved_at        TIMESTAMPTZ,
  declined_at        TIMESTAMPTZ,
  expires_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
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


/* ── Invoices (built-in accounting) ── */
CREATE TABLE IF NOT EXISTS invoices (
  id              SERIAL PRIMARY KEY,
  invoice_number  VARCHAR(50) UNIQUE NOT NULL,
  customer_id     INT REFERENCES customers(id),
  order_id        INT REFERENCES orders(id),
  quote_id        INT REFERENCES quotes(id),
  status          VARCHAR(20)   DEFAULT 'draft',
  line_items      JSONB         NOT NULL DEFAULT '[]',
  subtotal        DECIMAL(10,2) DEFAULT 0,
  tax_rate        DECIMAL(5,2)  DEFAULT 16,
  tax_amount      DECIMAL(10,2) DEFAULT 0,
  total           DECIMAL(10,2) DEFAULT 0,
  amount_paid     DECIMAL(10,2) DEFAULT 0,
  currency        VARCHAR(10)   DEFAULT 'KES',
  due_date        DATE,
  notes           TEXT,
  sent_at         TIMESTAMPTZ,
  paid_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

/* ── Payments against invoices ── */
CREATE TABLE IF NOT EXISTS payments (
  id           SERIAL PRIMARY KEY,
  invoice_id   INT REFERENCES invoices(id),
  amount       DECIMAL(10,2) NOT NULL,
  method       VARCHAR(50)  DEFAULT 'mpesa',
  reference    VARCHAR(255),
  notes        TEXT,
  recorded_at  TIMESTAMPTZ DEFAULT NOW(),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

/* ── Safe column additions for existing installs ── */
ALTER TABLE customers ADD COLUMN IF NOT EXISTS consent_status  VARCHAR(20)  DEFAULT 'pending';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS consented_at    TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS source          VARCHAR(50)  DEFAULT 'inbound';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS cluster         VARCHAR(255);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS territory       VARCHAR(255);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS service_tag     VARCHAR(255);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS crm_id          VARCHAR(255);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS manager_key     VARCHAR(255);
ALTER TABLE orders    ADD COLUMN IF NOT EXISTS invoice_ref      VARCHAR(255);
ALTER TABLE orders    ADD COLUMN IF NOT EXISTS quote_id         INT;
ALTER TABLE tickets   ADD COLUMN IF NOT EXISTS agent_id         INT;
ALTER TABLE catalog_cache ADD COLUMN IF NOT EXISTS category_id  INT;

/* ── Seed default menu items ── */
INSERT INTO menu_items (label, description, icon, action, display_order) VALUES
  ('Internet Packages',    'Browse our internet plans',         '📶', 'INTERNET_BROWSE', 1),
  ('Products & Equipment', 'CCTV, routers, networking gear',    '📦', 'PRODUCT_BROWSE',  2),
  ('Technical Support',    'Report an issue or fault',          '🔧', 'SUPPORT_AWAIT',   3),
  ('Speak to an Agent',    'Get help from our team directly',   '👤', 'AGENT_HANDOFF',   4)
ON CONFLICT DO NOTHING;


/* ════════════════════════════════════════════════════════════════
   MARKETPLACE TABLES
   ════════════════════════════════════════════════════════════════ */

/* ── Marketplace categories (separate from service categories) ── */
CREATE TABLE IF NOT EXISTS marketplace_categories (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  slug          VARCHAR(100) UNIQUE NOT NULL,
  icon          VARCHAR(20)   DEFAULT '📦',
  markup_pct    DECIMAL(5,2)  DEFAULT 20.00,
  display_order INT           DEFAULT 0,
  active        BOOLEAN       DEFAULT true,
  created_at    TIMESTAMPTZ   DEFAULT NOW()
);

/* ── External product sources (Jumia / AliExpress / Amazon / CSV) ── */
CREATE TABLE IF NOT EXISTS product_sources (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  type        VARCHAR(50)  NOT NULL,   /* jumia | aliexpress | amazon | csv | manual */
  config      JSONB        DEFAULT '{}',
  active      BOOLEAN      DEFAULT true,
  last_sync   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

/* ── Product catalog ── */
CREATE TABLE IF NOT EXISTS products (
  id            SERIAL PRIMARY KEY,
  sku           VARCHAR(255) UNIQUE,
  source_id     INT  REFERENCES product_sources(id),
  external_id   VARCHAR(255),
  category_id   INT  REFERENCES marketplace_categories(id),
  name          VARCHAR(500) NOT NULL,
  description   TEXT,
  image_url     VARCHAR(1000),
  cost_price    DECIMAL(10,2) DEFAULT 0,
  markup_pct    DECIMAL(5,2),        /* NULL = inherit from category */
  sell_price    DECIMAL(10,2),       /* NULL = auto from cost + markup */
  currency      VARCHAR(10)  DEFAULT 'KES',
  stock_status  VARCHAR(20)  DEFAULT 'in_stock',
  supplier_url  VARCHAR(1000),
  shipping_info VARCHAR(255),
  attributes    JSONB        DEFAULT '{}',
  active        BOOLEAN      DEFAULT true,
  featured      BOOLEAN      DEFAULT false,
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW()
);

/* ── Shopping carts ── */
CREATE TABLE IF NOT EXISTS carts (
  id          SERIAL PRIMARY KEY,
  customer_id INT REFERENCES customers(id),
  status      VARCHAR(20) DEFAULT 'active',  /* active | checked_out | abandoned */
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

/* ── Cart line items ── */
CREATE TABLE IF NOT EXISTS cart_items (
  id          SERIAL PRIMARY KEY,
  cart_id     INT REFERENCES carts(id) ON DELETE CASCADE,
  product_id  INT REFERENCES products(id),
  qty         INT          DEFAULT 1,
  unit_price  DECIMAL(10,2) NOT NULL,
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

/* ── Marketplace orders ── */
CREATE TABLE IF NOT EXISTS marketplace_orders (
  id                  SERIAL PRIMARY KEY,
  order_number        VARCHAR(50) UNIQUE NOT NULL,
  customer_id         INT  REFERENCES customers(id),
  cart_id             INT  REFERENCES carts(id),
  status              VARCHAR(50)   DEFAULT 'pending',
  delivery_address    TEXT,
  delivery_notes      TEXT,
  payment_method      VARCHAR(50)   DEFAULT 'mpesa',
  payment_status      VARCHAR(30)   DEFAULT 'unpaid',
  mpesa_checkout_id   VARCHAR(255),
  mpesa_receipt       VARCHAR(255),
  subtotal            DECIMAL(10,2) DEFAULT 0,
  delivery_fee        DECIMAL(10,2) DEFAULT 0,
  total               DECIMAL(10,2) DEFAULT 0,
  amount_paid         DECIMAL(10,2) DEFAULT 0,
  currency            VARCHAR(10)   DEFAULT 'KES',
  notes               TEXT,
  supplier_notified   BOOLEAN       DEFAULT false,
  dispatched_at       TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ   DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   DEFAULT NOW()
);

/* ── Order line items ── */
CREATE TABLE IF NOT EXISTS marketplace_order_items (
  id            SERIAL PRIMARY KEY,
  order_id      INT REFERENCES marketplace_orders(id),
  product_id    INT REFERENCES products(id),
  product_name  VARCHAR(500),
  qty           INT          DEFAULT 1,
  unit_price    DECIMAL(10,2) NOT NULL,
  cost_price    DECIMAL(10,2) DEFAULT 0,
  total         DECIMAL(10,2) NOT NULL,
  supplier_url  VARCHAR(1000),
  created_at    TIMESTAMPTZ  DEFAULT NOW()
);

/* ── M-Pesa Daraja transaction log ── */
CREATE TABLE IF NOT EXISTS mpesa_transactions (
  id                  SERIAL PRIMARY KEY,
  order_id            INT REFERENCES marketplace_orders(id),
  checkout_request_id VARCHAR(255),
  merchant_request_id VARCHAR(255),
  result_code         INT,
  result_desc         TEXT,
  amount              DECIMAL(10,2),
  receipt_number      VARCHAR(255),
  transaction_date    VARCHAR(50),
  phone               VARCHAR(20),
  raw                 JSONB,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

/* ── Marketplace indexes ── */
CREATE INDEX IF NOT EXISTS idx_products_category   ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_source     ON products(source_id);
CREATE INDEX IF NOT EXISTS idx_products_active     ON products(active);
CREATE INDEX IF NOT EXISTS idx_products_featured   ON products(featured);
CREATE INDEX IF NOT EXISTS idx_cart_items_cart     ON cart_items(cart_id);
CREATE INDEX IF NOT EXISTS idx_carts_customer      ON carts(customer_id);
CREATE INDEX IF NOT EXISTS idx_morders_customer    ON marketplace_orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_morders_status      ON marketplace_orders(status);
CREATE INDEX IF NOT EXISTS idx_morders_payment     ON marketplace_orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_mpesa_checkout      ON mpesa_transactions(checkout_request_id);

/* ── Seed default marketplace categories ── */
INSERT INTO marketplace_categories (name, slug, icon, markup_pct, display_order) VALUES
  ('Electronics',      'electronics',  '📱', 20, 1),
  ('Fashion',          'fashion',      '👕', 35, 2),
  ('Home & Living',    'home',         '🏠', 25, 3),
  ('Beauty & Health',  'beauty',       '💄', 30, 4),
  ('Kitchen',          'kitchen',      '🍳', 25, 5),
  ('Computers',        'computers',    '💻', 18, 6),
  ('Sports & Outdoor', 'sports',       '⚽', 30, 7),
  ('Toys & Kids',      'toys',         '🧸', 35, 8)
ON CONFLICT (slug) DO NOTHING;

/* ── Seed default product source (manual) ── */
INSERT INTO product_sources (name, type, config, active) VALUES
  ('Manual Entry', 'manual', '{}', true)
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

CREATE INDEX IF NOT EXISTS idx_invoices_customer  ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status    ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_payments_invoice   ON payments(invoice_id);
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
