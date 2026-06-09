'use strict';

/**
 * Internal REST API — admin dashboard backend.
 * All routes under /api/v1/
 *
 * Sections:
 *   GET  /stats                  — dashboard overview counts
 *   GET  /customers              — paginated customer list (with search/filter)
 *   GET  /orders                 — order list
 *   GET  /tickets                — ticket list
 *   GET  /catalog                — full catalog (manager + manual)
 *   GET  /catalog/items          — manual catalog items only (DB)
 *   POST /catalog/items          — add manual catalog item
 *   PUT  /catalog/items/:id      — edit manual catalog item
 *   DELETE /catalog/items/:id    — delete manual catalog item
 *   POST /catalog/refresh        — clear cache + re-pull from Manager.io
 *   POST /outreach/blast         — send consent messages to pending contacts
 *   GET  /outreach/pending       — list pending outreach contacts
 *   GET  /agents                 — list all agents
 *   POST /agents                 — create agent
 *   PUT  /agents/:id             — update agent
 *   DELETE /agents/:id           — deactivate agent
 *   GET  /categories             — list all categories
 *   POST /categories             — create category
 *   PUT  /categories/:id         — update category
 *   DELETE /categories/:id       — delete category
 *   GET  /quotes                 — list quotes (paginated)
 *   POST /quotes                 — create + send quote to customer
 *   GET  /sync-queue             — sync queue stats
 *   POST /sync/crm               — bulk push unsynced customers to Twenty CRM
 *   POST /sync/all               — full bidirectional sync (CRM <-> Manager.io)
 *   GET  /sync/status            — last sync run info + interval config
 *   PUT  /sync/config            — update sync enabled + interval
 */

const express  = require('express');
const { query } = require('../models/db');
const catalog  = require('../services/catalog');
const crm      = require('../services/crm');
const outreach = require('../services/outreach');
const agentSvc = require('../services/agents');
const quoteSvc = require('../services/quote');
const syncQ    = require('../services/sync-queue');
const biSync   = require('../services/bidirectional-sync');
const invoice  = require('../services/invoice');
const whatsapp = require('../services/whatsapp');
const cfgStore = require('../services/config-store');
const config   = require('../config');
const logger   = require('../utils/logger');

const router = express.Router();

// ── Dashboard stats ───────────────────────────────────────────────────────────

router.get('/stats', async (_req, res) => {
  try {
    const [customers, leads, orders, tickets, consented] = await Promise.all([
      query(`SELECT COUNT(*) FROM customers`),
      query(`SELECT COUNT(*) FROM leads`),
      query(`SELECT COUNT(*) FROM orders WHERE status NOT IN ('cancelled')`),
      query(`SELECT COUNT(*) FROM tickets WHERE status NOT IN ('resolved','closed')`),
      query(`SELECT COUNT(*) FROM customers WHERE consent_status = 'given'`),
    ]);

    const bySource = await query(
      `SELECT source, COUNT(*) AS count FROM customers GROUP BY source ORDER BY count DESC`
    );
    const recentLeads = await query(
      `SELECT c.phone, c.name, c.source, l.type, l.created_at
       FROM leads l JOIN customers c ON c.id = l.customer_id
       ORDER BY l.created_at DESC LIMIT 10`
    );
    const queueStats = await syncQ.getStats();

    return res.json({
      customers:   parseInt(customers.rows[0].count),
      leads:       parseInt(leads.rows[0].count),
      openOrders:  parseInt(orders.rows[0].count),
      openTickets: parseInt(tickets.rows[0].count),
      consented:   parseInt(consented.rows[0].count),
      bySource:    bySource.rows,
      recentLeads: recentLeads.rows,
      syncQueue:   queueStats,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Customers ─────────────────────────────────────────────────────────────────

router.get('/customers', async (req, res) => {
  try {
    const limit   = Math.min(parseInt(req.query.limit  || '50', 10), 500);
    const offset  = parseInt(req.query.offset || '0', 10);
    const search  = req.query.q       || '';
    const source  = req.query.source  || '';
    const consent = req.query.consent || '';

    const conditions = [];
    const params     = [];

    if (search) {
      params.push('%' + search + '%');
      conditions.push(`(phone ILIKE $${params.length} OR name ILIKE $${params.length})`);
    }
    if (source)  { params.push(source);  conditions.push(`source = $${params.length}`); }
    if (consent) { params.push(consent); conditions.push(`consent_status = $${params.length}`); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(limit, offset);

    const r = await query(
      `SELECT id, phone, name, source, consent_status, territory, cluster, service_tag, location, created_at
       FROM customers ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const total = await query(`SELECT COUNT(*) FROM customers ${where}`, params.slice(0, -2));
    return res.json({ customers: r.rows, total: parseInt(total.rows[0].count), limit, offset });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Orders ────────────────────────────────────────────────────────────────────

router.get('/orders', async (req, res) => {
  try {
    const status = req.query.status || '';
    const params = [];
    const where  = status ? (params.push(status), `WHERE o.status = $1`) : '';
    const r = await query(
      `SELECT o.id, o.product, o.status, o.invoice_ref, o.created_at, c.phone, c.name
       FROM orders o JOIN customers c ON c.id = o.customer_id
       ${where} ORDER BY o.created_at DESC LIMIT 100`,
      params
    );
    return res.json({ orders: r.rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Tickets ───────────────────────────────────────────────────────────────────

router.get('/tickets', async (req, res) => {
  try {
    const status = req.query.status || '';
    const params = [];
    const where  = status ? (params.push(status), `WHERE t.status = $1`) : `WHERE t.status NOT IN ('resolved','closed')`;
    const r = await query(
      `SELECT t.id, t.issue, t.status, t.priority, t.technician, t.created_at, c.phone, c.name
       FROM tickets t JOIN customers c ON c.id = t.customer_id
       ${where} ORDER BY t.priority ASC, t.created_at DESC LIMIT 100`,
      params
    );
    return res.json({ tickets: r.rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Catalog ───────────────────────────────────────────────────────────────────

router.get('/catalog', async (_req, res) => {
  try {
    const items = await catalog.getCatalog();
    return res.json({ items, count: items.length });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.post('/catalog/refresh', async (_req, res) => {
  try {
    await query(`DELETE FROM catalog_cache WHERE raw IS NOT NULL`);
    const items = await catalog.getCatalog();
    return res.json({ success: true, count: items.length });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.get('/catalog/items', async (_req, res) => {
  try {
    const r = await query(`SELECT * FROM catalog_cache ORDER BY type, name`);
    return res.json({ items: r.rows });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.post('/catalog/items', async (req, res) => {
  const { name, description, price, type } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const itemKey = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + Date.now();
  try {
    const r = await query(
      `INSERT INTO catalog_cache (item_key, name, description, price, type, cached_at)
       VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *`,
      [itemKey, name.trim(), description || null, parseFloat(price) || 0, type || 'product']
    );
    return res.json({ success: true, item: r.rows[0] });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.put('/catalog/items/:id', async (req, res) => {
  const { name, description, price, type } = req.body || {};
  try {
    const r = await query(
      `UPDATE catalog_cache SET name=$1, description=$2, price=$3, type=$4, cached_at=NOW()
       WHERE id=$5 RETURNING *`,
      [name, description || null, parseFloat(price) || 0, type || 'product', req.params.id]
    );
    return res.json({ success: true, item: r.rows[0] });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.delete('/catalog/items/:id', async (req, res) => {
  try {
    await query(`DELETE FROM catalog_cache WHERE id = $1`, [req.params.id]);
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ── Outreach ──────────────────────────────────────────────────────────────────

router.post('/outreach/blast', async (req, res) => {
  try {
    const { territory, cluster } = req.body || {};
    const result = await outreach.runBlast({ territory, cluster });
    return res.json({ success: true, ...result });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.get('/outreach/pending', async (req, res) => {
  try {
    const contacts = await outreach.getPendingContacts({
      territory: req.query.territory,
      cluster:   req.query.cluster,
      limit:     parseInt(req.query.limit || '200', 10),
    });
    return res.json({ contacts, count: contacts.length });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ── Agents ────────────────────────────────────────────────────────────────────

router.get('/agents', async (_req, res) => {
  try {
    const r = await query(`SELECT * FROM agents ORDER BY name`);
    return res.json({ agents: r.rows });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.post('/agents', async (req, res) => {
  const { name, phone, email, categories, escalation_phone, notes } = req.body || {};
  if (!name || !phone) return res.status(400).json({ error: 'name and phone are required' });
  try {
    const r = await query(
      `INSERT INTO agents (name, phone, email, categories, escalation_phone, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name.trim(), phone.trim(), email || null, categories || [], escalation_phone || null, notes || null]
    );
    return res.status(201).json({ success: true, agent: r.rows[0] });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.put('/agents/:id', async (req, res) => {
  const { name, phone, email, categories, escalation_phone, active, notes } = req.body || {};
  try {
    const r = await query(
      `UPDATE agents SET name=$1, phone=$2, email=$3, categories=$4,
         escalation_phone=$5, active=$6, notes=$7, updated_at=NOW()
       WHERE id=$8 RETURNING *`,
      [name, phone, email || null, categories || [], escalation_phone || null,
       active !== undefined ? active : true, notes || null, req.params.id]
    );
    return res.json({ success: true, agent: r.rows[0] });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.delete('/agents/:id', async (req, res) => {
  try {
    await query(`UPDATE agents SET active = false, updated_at = NOW() WHERE id = $1`, [req.params.id]);
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ── Categories ────────────────────────────────────────────────────────────────

router.get('/categories', async (_req, res) => {
  try {
    const r = await query(`SELECT * FROM categories ORDER BY display_order, name`);
    return res.json({ categories: r.rows });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.post('/categories', async (req, res) => {
  const { name, manager_group_key, display_order } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  try {
    const r = await query(
      `INSERT INTO categories (name, slug, manager_group_key, display_order)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name.trim(), slug, manager_group_key || null, parseInt(display_order) || 0]
    );
    return res.status(201).json({ success: true, category: r.rows[0] });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.put('/categories/:id', async (req, res) => {
  const { name, manager_group_key, display_order, active } = req.body || {};
  try {
    const r = await query(
      `UPDATE categories SET name=$1, manager_group_key=$2, display_order=$3, active=$4
       WHERE id=$5 RETURNING *`,
      [name, manager_group_key || null, parseInt(display_order) || 0,
       active !== undefined ? active : true, req.params.id]
    );
    return res.json({ success: true, category: r.rows[0] });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.delete('/categories/:id', async (req, res) => {
  try {
    await query(`DELETE FROM categories WHERE id = $1`, [req.params.id]);
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ── Quotes ────────────────────────────────────────────────────────────────────

router.get('/quotes', async (req, res) => {
  try {
    const status = req.query.status || '';
    const params = [];
    const where  = status ? (params.push(status), `WHERE q.status = $1`) : '';
    const r = await query(
      `SELECT q.id, q.status, q.total_amount, q.currency, q.manager_quote_ref,
              q.sent_at, q.approved_at, q.declined_at, q.created_at,
              c.phone, c.name
       FROM quotes q JOIN customers c ON c.id = q.customer_id
       ${where} ORDER BY q.created_at DESC LIMIT 100`,
      params
    );
    return res.json({ quotes: r.rows });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

/**
 * POST /quotes — admin creates a quote for a customer and sends it via WhatsApp.
 * Body: { phone, items: [{name, qty, price}], notes? }
 */
router.post('/quotes', async (req, res) => {
  const { phone, items, notes } = req.body || {};
  if (!phone)  return res.status(400).json({ error: 'phone is required' });
  if (!items?.length) return res.status(400).json({ error: 'items array is required' });

  try {
    const custRes = await query(`SELECT * FROM customers WHERE phone = $1`, [phone]);
    if (!custRes.rows.length) return res.status(404).json({ error: 'Customer not found — import or add them first' });
    const customer = custRes.rows[0];

    const quote = await quoteSvc.create({
      customerId:    customer.id,
      customerPhone: customer.phone,
      customerName:  customer.name,
      items,
      notes,
    });

    const msg = quoteSvc.buildWhatsAppMessage(quote, customer.name);
    await whatsapp.sendInteractive(phone, msg);
    await quoteSvc.markSent(quote.id);

    const session = require('../services/session');
    const { STATES } = require('../orchestrator');
    const sess = await session.get(phone);
    await session.set(phone, { ...sess, state: STATES.QUOTE_PENDING, pendingQuoteId: quote.id });

    logger.info('Quote sent to customer', { quoteId: quote.id, phone });
    return res.status(201).json({ success: true, quote });
  } catch (err) {
    logger.error('POST /quotes error', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ── Sync Queue ────────────────────────────────────────────────────────────────

router.get('/sync-queue', async (_req, res) => {
  try {
    const stats = await syncQ.getStats();
    const dead  = await query(
      `SELECT * FROM sync_queue WHERE status = 'dead' ORDER BY updated_at DESC LIMIT 20`
    );
    return res.json({ stats, deadItems: dead.rows });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.post('/sync-queue/retry/:id', async (req, res) => {
  try {
    await query(
      `UPDATE sync_queue SET status = 'pending', attempts = 0, next_retry_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ── CRM Bulk Sync ─────────────────────────────────────────────────────────────

/**
 * POST /sync/crm
 * Push all local customers that have no crm_id to Twenty CRM.
 * Safe to run repeatedly — already-synced customers are skipped.
 */
router.post('/sync/crm', async (_req, res) => {
  if (!config.crm.url || !config.crm.apiKey) {
    return res.status(400).json({ error: 'CRM not configured' });
  }
  try {
    const unsynced = await query(
      `SELECT id, phone, name, location FROM customers WHERE crm_id IS NULL ORDER BY created_at ASC`
    );
    const results = { synced: 0, failed: 0, skipped: 0, errors: [] };

    for (const customer of unsynced.rows) {
      try {
        const crmId = await crm.upsertPerson({ phone: customer.phone, name: customer.name });
        if (crmId) {
          await query(`UPDATE customers SET crm_id = $1 WHERE id = $2`, [crmId, customer.id]);
          if (customer.location) {
            await crm.updatePerson(crmId, { location: customer.location });
          }
          results.synced++;
        } else {
          results.skipped++;
        }
      } catch (err) {
        results.failed++;
        results.errors.push({ phone: customer.phone, error: err.message });
      }
    }

    logger.info('CRM bulk sync complete', results);
    return res.json({ success: true, total: unsynced.rows.length, ...results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Bidirectional Sync ────────────────────────────────────────────────────────

/**
 * POST /sync/all
 * Trigger a full bidirectional sync (Twenty CRM <-> Manager.io <-> Local DB).
 * Safe to call manually at any time.
 */
router.post('/sync/all', async (_req, res) => {
  try {
    const stats = await biSync.runSync();
    return res.json({ success: true, stats });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /sync/status
 * Return last sync run time + stats + current interval config.
 */
router.get('/sync/status', async (_req, res) => {
  try {
    const lastRun     = await cfgStore.get('sync_last_run',    '');
    const lastStats   = await cfgStore.get('sync_last_stats',  '{}');
    const enabled     = await cfgStore.get('sync_enabled',     'false');
    const intervalMin = await cfgStore.get('sync_interval_min','0');

    let parsedStats = null;
    try { parsedStats = lastStats ? JSON.parse(lastStats) : null; } catch (_) {}

    return res.json({
      enabled:     enabled === 'true',
      intervalMin: parseInt(intervalMin, 10) || 0,
      lastRun:     lastRun || null,
      lastStats:   parsedStats,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /sync/config
 * Update sync enabled flag and/or interval.
 * Body: { enabled: boolean, intervalMin: number }
 * Restarts the background worker with new settings.
 */
router.put('/sync/config', async (req, res) => {
  try {
    const { enabled, intervalMin } = req.body || {};
    const updates = {};
    if (enabled !== undefined)     updates.sync_enabled      = String(!!enabled);
    if (intervalMin !== undefined) updates.sync_interval_min = String(parseInt(intervalMin, 10) || 0);

    await cfgStore.setMany(updates);
    await biSync.startWorker(); // restart worker with new config

    return res.json({ success: true, applied: updates });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});


// ── Invoices ──────────────────────────────────────────────────────────────────

router.get('/invoices', async (req, res) => {
  try {
    await invoice.markOverdue();
    const result = await invoice.list({
      status:     req.query.status     || '',
      customerId: req.query.customerId || null,
      limit:      Math.min(parseInt(req.query.limit  || '50',  10), 200),
      offset:     parseInt(req.query.offset || '0', 10),
    });
    return res.json(result);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.get('/invoices/:id', async (req, res) => {
  try {
    const inv = await invoice.getById(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    return res.json(inv);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.get('/invoices/:id/html', async (req, res) => {
  try {
    const inv = await invoice.getById(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(invoice.buildHtml(inv));
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.post('/invoices', async (req, res) => {
  const { customerId, orderId, quoteId, lineItems, taxRate, notes, dueDate, currency } = req.body || {};
  if (!customerId)       return res.status(400).json({ error: 'customerId is required' });
  if (!lineItems?.length) return res.status(400).json({ error: 'lineItems array is required' });
  try {
    const inv = await invoice.create({ customerId, orderId, quoteId, lineItems, taxRate, notes, dueDate, currency });
    return res.status(201).json({ success: true, invoice: inv });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.put('/invoices/:id/send', async (req, res) => {
  try {
    const inv = await invoice.markSent(req.params.id);
    return res.json({ success: true, invoice: inv });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.put('/invoices/:id/cancel', async (req, res) => {
  try {
    const inv = await invoice.markCancelled(req.params.id);
    return res.json({ success: true, invoice: inv });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.post('/invoices/:id/payments', async (req, res) => {
  const { amount, method, reference, notes } = req.body || {};
  if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'amount is required' });
  try {
    const result = await invoice.recordPayment({
      invoiceId: req.params.id,
      amount: parseFloat(amount),
      method, reference, notes,
    });
    return res.status(201).json({ success: true, ...result });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ── Content & Flows ───────────────────────────────────────────────────────────

router.get('/content/messages', async (_req, res) => {
  try {
    const all = await cfgStore.getAll();
    return res.json({ messages: all, defaults: cfgStore.DEFAULTS });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.put('/content/messages', async (req, res) => {
  try {
    const updates = req.body || {};
    await cfgStore.setMany(updates);
    return res.json({ success: true, updated: Object.keys(updates) });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.post('/content/messages/:key/reset', async (req, res) => {
  try {
    await cfgStore.resetToDefault(req.params.key);
    return res.json({ success: true, key: req.params.key });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.get('/content/menu-items', async (_req, res) => {
  try {
    const r = await query(`SELECT * FROM menu_items ORDER BY display_order, id`);
    return res.json({ items: r.rows });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.post('/content/menu-items', async (req, res) => {
  const { label, description, icon, action, display_order } = req.body || {};
  if (!label || !action) return res.status(400).json({ error: 'label and action are required' });
  try {
    const r = await query(
      `INSERT INTO menu_items (label, description, icon, action, display_order)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [label, description || null, icon || '📌', action, parseInt(display_order) || 0]
    );
    return res.status(201).json({ success: true, item: r.rows[0] });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.put('/content/menu-items/:id', async (req, res) => {
  const { label, description, icon, action, display_order, active } = req.body || {};
  try {
    const r = await query(
      `UPDATE menu_items SET label=$1, description=$2, icon=$3, action=$4,
         display_order=$5, active=$6 WHERE id=$7 RETURNING *`,
      [label, description || null, icon || '📌', action,
       parseInt(display_order) || 0, active !== undefined ? active : true, req.params.id]
    );
    return res.json({ success: true, item: r.rows[0] });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.delete('/content/menu-items/:id', async (req, res) => {
  try {
    await query(`DELETE FROM menu_items WHERE id = $1`, [req.params.id]);
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ── Connection diagnostics ────────────────────────────────────────────────────

router.get('/diagnostics', async (_req, res) => {
  const results = {};
  const t = () => Date.now();

  // ── Database ──
  const dbStart = t();
  try {
    await query('SELECT 1');
    results.database = { ok: true, ms: t() - dbStart };
  } catch (e) {
    results.database = { ok: false, error: e.message, ms: t() - dbStart };
  }

  // ── Redis / Session ──
  const redisStart = t();
  try {
    const session = require('../services/session');
    await session.get('__diag_test__');
    results.redis = { ok: true, ms: t() - redisStart };
  } catch (e) {
    results.redis = { ok: false, error: e.message, ms: t() - redisStart };
  }

  // ── Twenty CRM ──
  const crmStart = t();
  if (!config.crm.url || !config.crm.apiKey) {
    results.crm = { ok: false, error: 'CRM_URL or CRM_API_KEY not set', configured: false };
  } else {
    try {
      const axios = require('axios');
      const r = await axios.post(
        `${config.crm.url}/graphql`,
        { query: '{ __typename }' },
        { headers: { Authorization: `Bearer ${config.crm.apiKey}`, 'Content-Type': 'application/json' }, timeout: 8000 }
      );
      const ok = !r.data?.errors?.length;
      results.crm = { ok, configured: true, url: config.crm.url, ms: t() - crmStart, graphqlTypename: r.data?.data?.__typename || null, errors: r.data?.errors || undefined };
    } catch (e) {
      results.crm = { ok: false, configured: true, url: config.crm.url, error: e.message, httpStatus: e.response?.status, ms: t() - crmStart };
    }
  }

  // ── Manager.io ──
  const mgrStart = t();
  if (!config.manager.url || !config.manager.apiKey) {
    results.manager = {
      ok: false,
      error: 'MANAGER_URL or MANAGER_API_KEY not set',
      configured: false,
      missing: [
        !config.manager.url    && 'MANAGER_URL',
        !config.manager.apiKey && 'MANAGER_API_KEY',
      ].filter(Boolean),
    };
  } else {
    try {
      const axios = require('axios');
      const r = await axios.get(`${config.manager.url}/customers`, {
        headers: { 'X-API-KEY': config.manager.apiKey, 'Content-Type': 'application/json' },
        timeout: 8000,
        maxRedirects: 0,
      });
      const customerCount = Array.isArray(r.data) ? r.data.length : (r.data.totalRecords || '?');
      results.manager = { ok: true, configured: true, url: config.manager.url, ms: t() - mgrStart, customerCount };
    } catch (e) {
      results.manager = { ok: false, configured: true, url: config.manager.url, error: e.message, httpStatus: e.response?.status, ms: t() - mgrStart };
    }
  }

  // ── Evolution API (WhatsApp) ──
  const waStart = t();
  if (!config.evolution.url || !config.evolution.apiKey) {
    results.whatsapp = { ok: false, error: 'EVOLUTION_API_URL or EVOLUTION_API_KEY not set', configured: false };
  } else {
    try {
      const axios = require('axios');
      const r = await axios.get(`${config.evolution.url}/instance/fetchInstances`, {
        headers: { apikey: config.evolution.apiKey },
        timeout: 8000,
      });
      const instances = Array.isArray(r.data) ? r.data.map(i => ({ name: i.instance?.instanceName, status: i.instance?.status })) : [];
      results.whatsapp = { ok: true, configured: true, url: config.evolution.url, instance: config.evolution.instance, ms: t() - waStart, instances };
    } catch (e) {
      results.whatsapp = { ok: false, configured: true, url: config.evolution.url, error: e.message, httpStatus: e.response?.status, ms: t() - waStart };
    }
  }

  const allOk = Object.values(results).every(r => r.ok);
  res.status(allOk ? 200 : 207).json({ status: allOk ? 'all_ok' : 'partial', results });
});


// ════════════════════════════════════════════════════════════════════════
// MARKETPLACE ROUTES
// ════════════════════════════════════════════════════════════════════════

const mktCatalog  = require('../services/marketplace/catalog');
const mktCart     = require('../services/marketplace/cart');
const mktCheckout = require('../services/marketplace/checkout');
const mktFetcher  = require('../services/marketplace/fetcher');
const mktReports  = require('../services/marketplace/reports');
const mktPayment  = require('../services/marketplace/payment');

// ── Categories ───────────────────────────────────────────────────────────────

router.get('/marketplace/categories', async (_req, res) => {
  try {
    const cats = await mktCatalog.getCategories();
    res.json({ categories: cats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/marketplace/categories', async (req, res) => {
  try {
    const cat = await mktCatalog.upsertCategory(req.body);
    res.status(201).json({ category: cat });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/marketplace/categories/:id', async (req, res) => {
  try {
    const cat = await mktCatalog.upsertCategory({ ...req.body, id: parseInt(req.params.id) });
    res.json({ category: cat });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Products ─────────────────────────────────────────────────────────────────

router.get('/marketplace/products', async (req, res) => {
  try {
    const { category_id, search, page, limit, featured } = req.query;
    const result = await mktCatalog.getProducts({
      categoryId:    category_id ? parseInt(category_id) : undefined,
      search,
      page:          parseInt(page || 1),
      limit:         parseInt(limit || 20),
      featuredOnly:  featured === 'true',
      includeInactive: req.query.include_inactive === 'true',
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/marketplace/products/:id', async (req, res) => {
  try {
    const p = await mktCatalog.getProduct(parseInt(req.params.id));
    if (!p) return res.status(404).json({ error: 'Product not found' });
    res.json({ product: p });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/marketplace/products', async (req, res) => {
  try {
    const p = await mktCatalog.createProduct(req.body);
    res.status(201).json({ product: p });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/marketplace/products/:id', async (req, res) => {
  try {
    const p = await mktCatalog.updateProduct(parseInt(req.params.id), req.body);
    res.json({ product: p });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Product Sources ───────────────────────────────────────────────────────────

router.get('/marketplace/sources', async (_req, res) => {
  try {
    const sources = await mktFetcher.getSources(false);
    res.json({ sources });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/marketplace/sources', async (req, res) => {
  try {
    const src = await mktFetcher.upsertSource(req.body);
    res.status(201).json({ source: src });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/marketplace/sources/:id', async (req, res) => {
  try {
    const src = await mktFetcher.upsertSource({ ...req.body, id: parseInt(req.params.id) });
    res.json({ source: src });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/marketplace/sources/:id/sync', async (req, res) => {
  try {
    const stats = await mktFetcher.syncSource(parseInt(req.params.id));
    res.json({ stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/marketplace/sources/sync-all', async (_req, res) => {
  try {
    const stats = await mktFetcher.syncAll();
    res.json({ stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// CSV import
router.post('/marketplace/products/import-csv', async (req, res) => {
  try {
    const { csvText, sourceId } = req.body;
    if (!csvText) return res.status(400).json({ error: 'csvText required' });
    const cats = await mktCatalog.getCategories();
    const catMap = {};
    cats.forEach(c => { catMap[c.slug] = c.id; });
    const items = mktFetcher.parseCsv(csvText, sourceId || 1, catMap);
    const stats = await mktCatalog.bulkUpsert(items);
    res.json({ stats, parsed: items.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Orders ────────────────────────────────────────────────────────────────────

router.get('/marketplace/orders', async (req, res) => {
  try {
    const { status, customer_id, limit, offset } = req.query;
    const orders = await mktCheckout.listOrders({
      status, customerId: customer_id ? parseInt(customer_id) : undefined,
      limit: parseInt(limit || 50), offset: parseInt(offset || 0),
    });
    res.json({ orders });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/marketplace/orders/:id', async (req, res) => {
  try {
    const order = await mktCheckout.getOrder(parseInt(req.params.id));
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ order });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/marketplace/orders/:id/dispatch', async (req, res) => {
  try {
    const order = await mktCheckout.markDispatched(parseInt(req.params.id), req.body.tracking_info);
    res.json({ order });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/marketplace/orders/:id/deliver', async (req, res) => {
  try {
    const order = await mktCheckout.markDelivered(parseInt(req.params.id));
    res.json({ order });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/marketplace/orders/:id/confirm-payment', async (req, res) => {
  try {
    const { amount, reference } = req.body;
    const order = await mktCheckout.confirmManualPayment(parseInt(req.params.id), amount, reference);
    res.json({ order });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── M-Pesa Daraja callback ────────────────────────────────────────────────────

router.post('/mpesa/callback', async (req, res) => {
  // Always respond 200 immediately — Daraja retries if it doesn't get a fast response
  res.json({ ResultCode: 0, ResultDesc: 'Success' });
  try {
    const result = await mktPayment.handleCallback(req.body);
    logger.info('mpesa/callback processed', result);
    // TODO: push WhatsApp confirmation to customer via their phone
    // const order = await mktCheckout.getOrder(result.orderId);
    // if (order && result.success) await whatsapp.sendText(order.phone, mktCheckout.buildOrderConfirmation(order));
  } catch (e) {
    logger.error('mpesa/callback error', { error: e.message });
  }
});

// ── Reports ───────────────────────────────────────────────────────────────────

router.get('/marketplace/reports/summary', async (req, res) => {
  try {
    const { from, to } = req.query;
    const [summary, profit, statusBreakdown, paymentMethods] = await Promise.all([
      mktReports.getSalesSummary({ from, to }),
      mktReports.getProfitMargin({ from, to }),
      mktReports.getOrderStatusBreakdown(),
      mktReports.getPaymentMethodBreakdown({ from, to }),
    ]);
    res.json({ summary, profit, statusBreakdown, paymentMethods });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/marketplace/reports/daily', async (req, res) => {
  try {
    const data = await mktReports.getDailyRevenue(req.query);
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/marketplace/reports/products', async (req, res) => {
  try {
    const data = await mktReports.getTopProducts({ ...req.query, limit: parseInt(req.query.limit || 15) });
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/marketplace/reports/customers', async (req, res) => {
  try {
    const data = await mktReports.getTopCustomers({ ...req.query, limit: parseInt(req.query.limit || 15) });
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/marketplace/reports/categories', async (req, res) => {
  try {
    const data = await mktReports.getRevenueByCategory(req.query);
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/marketplace/reports/full', async (req, res) => {
  try {
    const data = await mktReports.getFullReport(req.query);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/marketplace/reports/sources', async (req, res) => {
  try {
    const data = await mktReports.getSourcePerformance(req.query);
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
