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


/* ════════════════════════════════════════════════════════════════
   PHASE 1 — CRM PIPELINE
   ════════════════════════════════════════════════════════════════ */

/* ── Sales pipeline stages ── */
CREATE TABLE IF NOT EXISTS pipeline_stages (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  slug          VARCHAR(50)  UNIQUE NOT NULL,
  display_order INT          DEFAULT 0,
  color         VARCHAR(20)  DEFAULT '#6366f1',
  is_won        BOOLEAN      DEFAULT false,
  is_lost       BOOLEAN      DEFAULT false,
  active        BOOLEAN      DEFAULT true,
  created_at    TIMESTAMPTZ  DEFAULT NOW()
);

/* ── Deals / opportunities ── */
CREATE TABLE IF NOT EXISTS deals (
  id            SERIAL PRIMARY KEY,
  title         VARCHAR(255) NOT NULL,
  customer_id   INT  REFERENCES customers(id),
  stage_id      INT  REFERENCES pipeline_stages(id),
  assigned_to   INT  REFERENCES agents(id),
  value         DECIMAL(10,2) DEFAULT 0,
  currency      VARCHAR(10)   DEFAULT 'KES',
  source        VARCHAR(50)   DEFAULT 'whatsapp',
  priority      VARCHAR(20)   DEFAULT 'medium',
  expected_close DATE,
  notes         TEXT,
  won_at        TIMESTAMPTZ,
  lost_at       TIMESTAMPTZ,
  lost_reason   TEXT,
  created_at    TIMESTAMPTZ   DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   DEFAULT NOW()
);

/* ── Customer activity log (calls, notes, WA messages) ── */
CREATE TABLE IF NOT EXISTS activities (
  id            SERIAL PRIMARY KEY,
  customer_id   INT  REFERENCES customers(id),
  deal_id       INT  REFERENCES deals(id),
  type          VARCHAR(30)  NOT NULL,  /* note | call | whatsapp | email | meeting */
  body          TEXT,
  created_by    VARCHAR(100),           /* agent name or 'system' */
  created_at    TIMESTAMPTZ  DEFAULT NOW()
);

/* ── Pipeline indexes ── */
CREATE INDEX IF NOT EXISTS idx_deals_customer  ON deals(customer_id);
CREATE INDEX IF NOT EXISTS idx_deals_stage     ON deals(stage_id);
CREATE INDEX IF NOT EXISTS idx_activities_cust ON activities(customer_id);
CREATE INDEX IF NOT EXISTS idx_activities_deal ON activities(deal_id);

/* ── Seed default pipeline stages ── */
INSERT INTO pipeline_stages (name, slug, display_order, color) VALUES
  ('New Lead',    'new',        1, '#6366f1'),
  ('Contacted',   'contacted',  2, '#0ea5e9'),
  ('Qualified',   'qualified',  3, '#f59e0b'),
  ('Proposal',    'proposal',   4, '#8b5cf6'),
  ('Negotiation', 'negotiation',5, '#f97316'),
  ('Won',         'won',        6, '#22c55e'),
  ('Lost',        'lost',       7, '#ef4444')
ON CONFLICT (slug) DO NOTHING;

/* ════════════════════════════════════════════════════════════════
   PHASE 2 — STORE ENHANCEMENTS
   ════════════════════════════════════════════════════════════════ */

/* ── Product variants (size, colour, etc.) ── */
CREATE TABLE IF NOT EXISTS product_variants (
  id           SERIAL PRIMARY KEY,
  product_id   INT  REFERENCES products(id) ON DELETE CASCADE,
  sku          VARCHAR(255) UNIQUE,
  name         VARCHAR(255) NOT NULL,      /* e.g. "Red / XL" */
  attributes   JSONB  DEFAULT '{}',        /* {color:"Red", size:"XL"} */
  extra_price  DECIMAL(10,2) DEFAULT 0,    /* added to product price */
  stock_qty    INT    DEFAULT 0,
  active       BOOLEAN DEFAULT true,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

/* ── Add stock_qty to products ── */
ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_qty     INT DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS track_stock   BOOLEAN DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS low_stock_qty INT DEFAULT 5;

/* ── Discount / coupon codes ── */
CREATE TABLE IF NOT EXISTS discount_codes (
  id              SERIAL PRIMARY KEY,
  code            VARCHAR(50) UNIQUE NOT NULL,
  description     VARCHAR(255),
  type            VARCHAR(20) DEFAULT 'pct',    /* pct | fixed */
  value           DECIMAL(10,2) NOT NULL,        /* percent or KES amount */
  min_order_value DECIMAL(10,2) DEFAULT 0,
  max_uses        INT,
  used_count      INT DEFAULT 0,
  applies_to      VARCHAR(20) DEFAULT 'all',     /* all | category | product */
  target_id       INT,                           /* category_id or product_id */
  active          BOOLEAN DEFAULT true,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

/* ── Shipping zones ── */
CREATE TABLE IF NOT EXISTS shipping_zones (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,         /* "Nairobi CBD", "Upcountry", "Int'l" */
  regions     TEXT[],                        /* list of area names */
  rate        DECIMAL(10,2) DEFAULT 0,
  free_above  DECIMAL(10,2),                 /* free shipping if order > this */
  est_days    VARCHAR(50) DEFAULT '2-3 days',
  active      BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

/* ── Record discount used on order ── */
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS discount_code   VARCHAR(50);
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS discount_amount DECIMAL(10,2) DEFAULT 0;

/* ── Shipping zone on order ── */
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS shipping_zone_id INT;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS shipping_rate    DECIMAL(10,2) DEFAULT 0;

/* ── Store indexes ── */
CREATE INDEX IF NOT EXISTS idx_variants_product    ON product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_discount_code       ON discount_codes(code);

/* ── Seed default shipping zones ── */
INSERT INTO shipping_zones (name, regions, rate, free_above, est_days) VALUES
  ('Nairobi CBD',    ARRAY['CBD','Westlands','Kilimani','Lavington'], 200,  5000, '1-2 days'),
  ('Nairobi Suburbs',ARRAY['Karen','Runda','Gigiri','Muthaiga'],      350,  8000, '1-2 days'),
  ('Upcountry',      ARRAY['Mombasa','Kisumu','Nakuru','Eldoret'],    500,  10000,'2-4 days'),
  ('Remote / Rural', ARRAY['Other areas'],                            800,  15000,'3-6 days')
ON CONFLICT DO NOTHING;

/* ════════════════════════════════════════════════════════════════
   PHASE 3 — FINANCE
   ════════════════════════════════════════════════════════════════ */

/* ── Business expenses ── */
CREATE TABLE IF NOT EXISTS expenses (
  id          SERIAL PRIMARY KEY,
  category    VARCHAR(100) NOT NULL,        /* rent, salaries, marketing, etc. */
  description TEXT,
  amount      DECIMAL(10,2) NOT NULL,
  currency    VARCHAR(10)   DEFAULT 'KES',
  receipt_ref VARCHAR(255),
  expense_date DATE          DEFAULT CURRENT_DATE,
  created_at  TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
CREATE INDEX IF NOT EXISTS idx_expenses_cat  ON expenses(category);
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

-- ═══════════════════════════════════════════════════════════════════════════════
-- PROSPECTHUB FEATURES — merged into Laitor Engine
-- Campaigns · Broadcasts · Lead Scoring · Commissions · Deliveries · Suppliers
-- Admin Auth
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── Extend customers with ProspectHub fields ─────────────────────────────────
ALTER TABLE customers ADD COLUMN IF NOT EXISTS segment      VARCHAR(50)  DEFAULT 'general';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS lead_score   SMALLINT     DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS opted_in     BOOLEAN      DEFAULT false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS opted_out_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_contact TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS contact_count INT DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS response_count INT DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS assigned_agent_id INT REFERENCES agents(id) ON DELETE SET NULL;

-- ─── Extend agents with commission + team ─────────────────────────────────────
ALTER TABLE agents ADD COLUMN IF NOT EXISTS team            VARCHAR(100);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(5,2) DEFAULT 5.00;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS monthly_target  NUMERIC(12,2) DEFAULT 0;

-- ─── Lead score log ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lead_score_logs (
  id            SERIAL PRIMARY KEY,
  customer_id   INT REFERENCES customers(id) ON DELETE CASCADE NOT NULL,
  score         SMALLINT NOT NULL,
  factors       JSONB NOT NULL DEFAULT '{}',
  scored_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lsl_customer ON lead_score_logs(customer_id);

-- ─── Campaigns ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaigns (
  id                SERIAL PRIMARY KEY,
  name              VARCHAR(255) NOT NULL,
  channel           VARCHAR(20)  NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp','sms','email')),
  message_template  TEXT         NOT NULL,
  segment_filter    JSONB        NOT NULL DEFAULT '{}',
  -- segment_filter: { segments:[], locations:[], min_score:0, opted_in_only:true, status:[] }
  status            VARCHAR(20)  NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','running','completed','paused')),
  total_recipients  INT          NOT NULL DEFAULT 0,
  sent_count        INT          NOT NULL DEFAULT 0,
  response_count    INT          NOT NULL DEFAULT 0,
  created_by        INT REFERENCES agents(id) ON DELETE SET NULL,
  scheduled_at      TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── Broadcasts (executed sends) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS broadcasts (
  id           SERIAL PRIMARY KEY,
  campaign_id  INT REFERENCES campaigns(id) ON DELETE CASCADE NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
  sent_count   INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS broadcast_recipients (
  id            SERIAL PRIMARY KEY,
  broadcast_id  INT REFERENCES broadcasts(id) ON DELETE CASCADE NOT NULL,
  customer_id   INT REFERENCES customers(id) ON DELETE CASCADE NOT NULL,
  phone         VARCHAR(30) NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','replied')),
  sent_at       TIMESTAMPTZ,
  error         TEXT,
  UNIQUE (broadcast_id, customer_id)
);
CREATE INDEX IF NOT EXISTS idx_br_broadcast  ON broadcast_recipients(broadcast_id);
CREATE INDEX IF NOT EXISTS idx_br_customer   ON broadcast_recipients(customer_id);

-- ─── Commission rates ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commission_rates (
  id           SERIAL PRIMARY KEY,
  category_id  INT REFERENCES categories(id) ON DELETE SET NULL,
  product_name VARCHAR(255),
  rate_pct     NUMERIC(5,2) NOT NULL DEFAULT 5.00,
  flat_amount  NUMERIC(10,2),
  active       BOOLEAN NOT NULL DEFAULT true
);

-- ─── Commissions earned ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commissions (
  id           SERIAL PRIMARY KEY,
  agent_id     INT REFERENCES agents(id) ON DELETE CASCADE NOT NULL,
  customer_id  INT REFERENCES customers(id) ON DELETE SET NULL,
  order_id     INT REFERENCES marketplace_orders(id) ON DELETE SET NULL,
  invoice_id   INT REFERENCES invoices(id) ON DELETE SET NULL,
  description  TEXT,
  sale_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,
  rate_pct     NUMERIC(5,2)  NOT NULL DEFAULT 5.00,
  commission   NUMERIC(12,2) NOT NULL DEFAULT 0,
  status       VARCHAR(20)   NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','paid')),
  period       VARCHAR(7),  -- 'YYYY-MM'
  paid_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_comm_agent  ON commissions(agent_id);
CREATE INDEX IF NOT EXISTS idx_comm_period ON commissions(period);

-- ─── Suppliers ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS suppliers (
  id             SERIAL PRIMARY KEY,
  name           VARCHAR(255) NOT NULL,
  contact_name   VARCHAR(255),
  phone          VARCHAR(30),
  email          VARCHAR(255),
  location       VARCHAR(255),
  category       VARCHAR(100),
  payment_terms  VARCHAR(100),
  lead_time_days INT DEFAULT 3,
  notes          TEXT,
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Link supplier to marketplace products
ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_id INT REFERENCES suppliers(id) ON DELETE SET NULL;

-- ─── Delivery jobs ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS delivery_jobs (
  id              SERIAL PRIMARY KEY,
  order_id        INT REFERENCES marketplace_orders(id) ON DELETE SET NULL,
  customer_id     INT REFERENCES customers(id) ON DELETE SET NULL,
  rider_name      VARCHAR(255),
  rider_phone     VARCHAR(30),
  pickup_address  TEXT,
  delivery_address TEXT NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','picked_up','in_transit','delivered','failed','cancelled')),
  estimated_at    TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dj_order    ON delivery_jobs(order_id);
CREATE INDEX IF NOT EXISTS idx_dj_status   ON delivery_jobs(status);

CREATE TABLE IF NOT EXISTS delivery_events (
  id           SERIAL PRIMARY KEY,
  job_id       INT REFERENCES delivery_jobs(id) ON DELETE CASCADE NOT NULL,
  status       VARCHAR(20) NOT NULL,
  notes        TEXT,
  location     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Admin users (local auth — no Supabase) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(100) UNIQUE NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          VARCHAR(20) NOT NULL DEFAULT 'agent' CHECK (role IN ('admin','manager','agent')),
  agent_id      INT REFERENCES agents(id) ON DELETE SET NULL,
  active        BOOLEAN NOT NULL DEFAULT true,
  last_login    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Outreach config ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outreach_config (
  id             SERIAL PRIMARY KEY,
  max_per_day    INT NOT NULL DEFAULT 500,
  send_start_hr  INT NOT NULL DEFAULT 8,
  send_end_hr    INT NOT NULL DEFAULT 20,
  delay_ms       INT NOT NULL DEFAULT 1500,  -- between sends
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO outreach_config (id) VALUES (1) ON CONFLICT DO NOTHING;

`;

// ─── Password helpers (inlined — no external deps) ────────────────────────────
const crypto = require('crypto');

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

// ─── Seed default admin user ───────────────────────────────────────────────────
async function seedDefaultAdmin(client) {
  const { rows } = await client.query(
    `SELECT COUNT(*) AS n FROM admin_users WHERE role = 'admin'`
  );
  if (parseInt(rows[0].n) > 0) {
    console.log('[migrate] Admin user already exists — skipping seed.');
    return;
  }

  const username = process.env.ADMIN_DEFAULT_USERNAME || 'admin';
  const email    = process.env.ADMIN_DEFAULT_EMAIL    || 'admin@laitor.co';
  const password = process.env.ADMIN_DEFAULT_PASSWORD || 'Laitor@2024';
  const hash     = hashPassword(password);

  await client.query(
    `INSERT INTO admin_users (username, email, password_hash, role)
     VALUES ($1, $2, $3, 'admin')
     ON CONFLICT DO NOTHING`,
    [username, email, hash]
  );

  console.log('[migrate] ✓ Default admin created.');
  console.log(`[migrate]   Username : ${username}`);
  console.log(`[migrate]   Email    : ${email}`);
  console.log(`[migrate]   Password : ${password}`);
  console.log('[migrate]   ⚠  Change this password immediately after first login!');
}

(async () => {
  let client;
  try {
    client = await pool.connect();
    console.log('[migrate] Connected. Applying schema...');
    await client.query(schema);
    console.log('[migrate] Schema applied successfully.');
    await seedDefaultAdmin(client);
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
