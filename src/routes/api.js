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
 */

const express  = require('express');
const { query } = require('../models/db');
const catalog  = require('../services/catalog');
const outreach = require('../services/outreach');
const agentSvc = require('../services/agents');
const quoteSvc = require('../services/quote');
const syncQ    = require('../services/sync-queue');
const whatsapp = require('../services/whatsapp');
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
    await query(`DELETE FROM catalog_cache`);
    const items = await catalog.getCatalog();
    return res.json({ refreshed: true, count: items.length });
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

    // Send to customer via WhatsApp
    const msg = quoteSvc.buildWhatsAppMessage(quote, customer.name);
    await whatsapp.sendInteractive(phone, msg);
    await quoteSvc.markSent(quote.id);

    // Set customer session to QUOTE_PENDING so their next tap is handled correctly
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

module.exports = router;
