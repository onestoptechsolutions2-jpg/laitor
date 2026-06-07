'use strict';

/**
 * Internal REST API for the admin dashboard.
 * All routes are under /api/v1/
 */

const express = require('express');
const { query } = require('../models/db');
const catalog  = require('../services/catalog');
const outreach = require('../services/outreach');
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

    return res.json({
      customers:  parseInt(customers.rows[0].count),
      leads:      parseInt(leads.rows[0].count),
      openOrders: parseInt(orders.rows[0].count),
      openTickets:parseInt(tickets.rows[0].count),
      consented:  parseInt(consented.rows[0].count),
      bySource:   bySource.rows,
      recentLeads: recentLeads.rows,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Customers ─────────────────────────────────────────────────────────────────

router.get('/customers', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || '50', 10), 500);
    const offset = parseInt(req.query.offset || '0', 10);
    const search = req.query.q || '';
    const source = req.query.source || '';
    const consent = req.query.consent || '';

    const conditions = [];
    const params = [];

    if (search) {
      params.push('%' + search + '%');
      conditions.push(`(phone ILIKE $${params.length} OR name ILIKE $${params.length})`);
    }
    if (source) {
      params.push(source);
      conditions.push(`source = $${params.length}`);
    }
    if (consent) {
      params.push(consent);
      conditions.push(`consent_status = $${params.length}`);
    }

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
      `SELECT o.id, o.product, o.status, o.created_at, c.phone, c.name
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
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/catalog/refresh', async (_req, res) => {
  try {
    await query(`DELETE FROM catalog_cache`);
    const items = await catalog.getCatalog();
    return res.json({ refreshed: true, count: items.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Outreach ──────────────────────────────────────────────────────────────────

router.post('/outreach/blast', async (req, res) => {
  try {
    const { territory, cluster } = req.body || {};
    const result = await outreach.runBlast({ territory, cluster });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/outreach/pending', async (req, res) => {
  try {
    const contacts = await outreach.getPendingContacts({
      territory: req.query.territory,
      cluster:   req.query.cluster,
      limit:     parseInt(req.query.limit || '200', 10),
    });
    return res.json({ contacts, count: contacts.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
