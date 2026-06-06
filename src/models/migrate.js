'use strict';

require('dotenv').config();
const { pool } = require('./db');
const logger = require('../utils/logger');

const schema = `
-- Customers
CREATE TABLE IF NOT EXISTS customers (
  id          SERIAL PRIMARY KEY,
  phone       VARCHAR(20) UNIQUE NOT NULL,
  name        VARCHAR(255),
  location    VARCHAR(255),
  tags        TEXT[],
  crm_id      VARCHAR(255),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Leads
CREATE TABLE IF NOT EXISTS leads (
  id           SERIAL PRIMARY KEY,
  customer_id  INT REFERENCES customers(id),
  type         VARCHAR(50) NOT NULL,   -- INTERNET_LEAD | PRODUCT_ORDER | SUPPORT_REQUEST
  status       VARCHAR(50) DEFAULT 'new',
  notes        TEXT,
  crm_lead_id  VARCHAR(255),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Orders
CREATE TABLE IF NOT EXISTS orders (
  id               SERIAL PRIMARY KEY,
  customer_id      INT REFERENCES customers(id),
  product          VARCHAR(255),
  status           VARCHAR(50) DEFAULT 'pending',
  supplier_status  VARCHAR(50) DEFAULT 'pending',
  notes            TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Tickets
CREATE TABLE IF NOT EXISTS tickets (
  id           SERIAL PRIMARY KEY,
  customer_id  INT REFERENCES customers(id),
  issue        TEXT NOT NULL,
  priority     VARCHAR(20) DEFAULT 'medium',
  status       VARCHAR(50) DEFAULT 'open',
  technician   VARCHAR(255),
  crm_ticket_id VARCHAR(255),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Messages (audit trail)
CREATE TABLE IF NOT EXISTS messages (
  id          SERIAL PRIMARY KEY,
  phone       VARCHAR(20) NOT NULL,
  direction   VARCHAR(10) NOT NULL,  -- 'in' | 'out'
  text        TEXT,
  raw         JSONB,
  msg_id      VARCHAR(255) UNIQUE,   -- idempotency key
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_customers_phone   ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_messages_phone    ON messages(phone);
CREATE INDEX IF NOT EXISTS idx_messages_msg_id   ON messages(msg_id);
CREATE INDEX IF NOT EXISTS idx_leads_customer    ON leads(customer_id);
CREATE INDEX IF NOT EXISTS idx_tickets_customer  ON tickets(customer_id);
`;

(async () => {
  try {
    logger.info('Running database migration...');
    await pool.query(schema);
    logger.info('Migration complete.');
  } catch (err) {
    logger.error('Migration failed', {
      message: err.message,
      code:    err.code,
      detail:  err.detail,
      hint:    err.hint,
      stack:   err.stack,
    });
    console.error('[migrate] FULL ERROR:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
