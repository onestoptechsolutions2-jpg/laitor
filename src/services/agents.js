'use strict';

/**
 * @module agents
 * @description Agent assignment and notification service.
 *
 * Each category (internet, products, support, finance) is handled by one
 * designated agent (a team member). When a lead, order, ticket, or quote
 * is created, the responsible agent is notified via WhatsApp.
 *
 * Agent data is stored in the `agents` table and managed via the admin dashboard.
 * If no agent is configured for a category, the escalation falls to ADMIN_PHONES.
 *
 * Notification format:
 *   🔔 [category] — [event]
 *   Customer: [name] ([phone])
 *   Ref: [ref]
 *   [optional details]
 */

const { query }    = require('../models/db');
const whatsapp     = require('./whatsapp');
const syncQueue    = require('./sync-queue');
const logger       = require('../utils/logger');

// ── Category constants ────────────────────────────────────────────────────────

const CATEGORIES = {
  INTERNET:  'internet',
  PRODUCTS:  'products',
  SUPPORT:   'support',
  FINANCE:   'finance',
  GENERAL:   'general',
};

// ── Agent lookup ──────────────────────────────────────────────────────────────

/**
 * Get the first active agent assigned to a given category.
 * Falls back to any active agent with category 'general'.
 *
 * @param {string} category - One of CATEGORIES values
 * @returns {Promise<object|null>} Agent row, or null if none configured
 */
const getAgentForCategory = async (category) => {
  try {
    const res = await query(
      `SELECT * FROM agents WHERE $1 = ANY(categories) AND active = true ORDER BY id LIMIT 1`,
      [category]
    );
    if (res.rows.length > 0) return res.rows[0];

    // Fallback: general category
    const fallback = await query(
      `SELECT * FROM agents WHERE 'general' = ANY(categories) AND active = true ORDER BY id LIMIT 1`
    );
    return fallback.rows[0] || null;
  } catch (err) {
    logger.warn('agents: getAgentForCategory failed', { category, error: err.message });
    return null;
  }
};

/**
 * Get all active agents.
 * @returns {Promise<Array>}
 */
const getAllAgents = async () => {
  try {
    const res = await query(`SELECT * FROM agents WHERE active = true ORDER BY name`);
    return res.rows;
  } catch (err) {
    logger.warn('agents: getAllAgents failed', { error: err.message });
    return [];
  }
};

// ── Notification ──────────────────────────────────────────────────────────────

/**
 * Send a WhatsApp notification to the agent responsible for a category.
 * If no agent is configured, notifies ADMIN_PHONES instead.
 * Non-fatal: errors are queued for retry via sync_queue.
 *
 * @param {object} params
 * @param {string}        params.category    - Category key (internet/products/support/finance)
 * @param {string}        params.event       - Short event description, e.g. 'New Lead'
 * @param {string}        params.customerName  - Customer display name
 * @param {string}        params.customerPhone - Customer phone number
 * @param {string}        params.ref           - Reference ID, e.g. 'TICKET#42'
 * @param {string}        [params.details]     - Optional extra detail lines
 * @returns {Promise<void>}
 */
const notifyAgent = async ({ category, event, customerName, customerPhone, ref, details }) => {
  try {
    const agent       = await getAgentForCategory(category);
    const adminPhones = (process.env.ADMIN_PHONES || '').split(',').map((p) => p.trim()).filter(Boolean);

    const emoji = {
      internet: '📶',
      products: '📦',
      support:  '🔧',
      finance:  '💰',
      general:  '🔔',
    }[category] || '🔔';

    const message = [
      `${emoji} *${event}* — ${category.toUpperCase()}`,
      `👤 Customer: *${customerName || 'Unknown'}* (${customerPhone})`,
      `📎 Ref: *${ref}*`,
      details ? `\n${details}` : '',
      `\n_Laitor Engine — ${new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })}_`,
    ].filter(Boolean).join('\n');

    // Notify assigned agent
    if (agent) {
      await whatsapp.sendText(agent.phone, message);
      logger.info('agents: agent notified', { agent: agent.name, category, ref });
    }

    // Also notify admins if configured (or if no agent found)
    if (!agent && adminPhones.length > 0) {
      for (const adminPhone of adminPhones.slice(0, 2)) {
        await whatsapp.sendText(adminPhone, message);
      }
      logger.info('agents: fallback admin notified', { adminPhones, category, ref });
    }
  } catch (err) {
    logger.warn('agents: notifyAgent failed — queuing retry', { category, ref, error: err.message });
    // Queue for retry so the failure doesn't silently disappear
    await syncQueue.enqueue({
      entityType: 'agent_notification',
      entityId:   ref,
      target:     'whatsapp',
      payload:    { category, event, customerName, customerPhone, ref, details },
    }).catch(() => {});
  }
};

// ── Convenience notification helpers ──────────────────────────────────────────

/**
 * Notify the internet agent of a new lead.
 * @param {object} p - { phone, name, service, ref }
 */
const notifyNewLead = (p) =>
  notifyAgent({
    category:      CATEGORIES.INTERNET,
    event:         'New Internet Lead',
    customerName:  p.name,
    customerPhone: p.phone,
    ref:           p.ref || 'LEAD-' + Date.now(),
    details:       p.service ? `Service interest: ${p.service}` : undefined,
  });

/**
 * Notify the products agent of a new order.
 * @param {object} p - { phone, name, product, orderId }
 */
const notifyNewOrder = (p) =>
  notifyAgent({
    category:      CATEGORIES.PRODUCTS,
    event:         'New Order',
    customerName:  p.name,
    customerPhone: p.phone,
    ref:           `ORDER#${p.orderId}`,
    details:       `Product: ${p.product}${p.notes ? '\n' + p.notes : ''}`,
  });

/**
 * Notify the support agent of a new ticket.
 * @param {object} p - { phone, name, issue, ticketId, priority }
 */
const notifyNewTicket = (p) =>
  notifyAgent({
    category:      CATEGORIES.SUPPORT,
    event:         'New Support Ticket',
    customerName:  p.name,
    customerPhone: p.phone,
    ref:           `TICKET#${p.ticketId}`,
    details:       `Priority: ${(p.priority || 'medium').toUpperCase()}\nIssue: ${p.issue}`,
  });

/**
 * Notify the finance agent that a new invoice was issued.
 * @param {object} p - { phone, name, invoiceRef, amount }
 */
const notifyNewInvoice = (p) =>
  notifyAgent({
    category:      CATEGORIES.FINANCE,
    event:         'Invoice Issued',
    customerName:  p.name,
    customerPhone: p.phone,
    ref:           p.invoiceRef,
    details:       p.amount ? `Amount: KES ${p.amount}` : undefined,
  });

/**
 * Notify the finance agent that a quote was approved.
 * @param {object} p - { phone, name, quoteId, amount }
 */
const notifyQuoteApproved = (p) =>
  notifyAgent({
    category:      CATEGORIES.FINANCE,
    event:         'Quote Approved ✅',
    customerName:  p.name,
    customerPhone: p.phone,
    ref:           `QUOTE#${p.quoteId}`,
    details:       p.amount ? `Total: KES ${p.amount}` : undefined,
  });

/**
 * Notify the relevant agent that a quote was declined.
 * @param {object} p - { phone, name, quoteId, category }
 */
const notifyQuoteDeclined = (p) =>
  notifyAgent({
    category:      p.category || CATEGORIES.INTERNET,
    event:         'Quote Declined ❌',
    customerName:  p.name,
    customerPhone: p.phone,
    ref:           `QUOTE#${p.quoteId}`,
    details:       'Customer declined the quote. Follow up recommended.',
  });

module.exports = {
  CATEGORIES,
  getAgentForCategory,
  getAllAgents,
  notifyAgent,
  notifyNewLead,
  notifyNewOrder,
  notifyNewTicket,
  notifyNewInvoice,
  notifyQuoteApproved,
  notifyQuoteDeclined,
};
