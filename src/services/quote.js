'use strict';

/**
 * @module quote
 * @description Quote lifecycle service.
 *
 * Quotes are the approval gate between a customer expressing interest and
 * a sales invoice being created. The flow:
 *
 *   1. Agent (or admin) creates a quote via POST /api/v1/quotes
 *   2. Engine creates a Sales Quote in Manager.io and a row in the quotes table
 *   3. Engine sends the quote to the customer via WhatsApp with Approve/Decline buttons
 *   4. Customer's reply is captured in orchestrator QUOTE_PENDING state
 *   5a. Approve → convertQuoteToInvoice() in Manager.io + advance CRM to WON
 *   5b. Decline → CRM stage → LOST, sales agent notified
 *
 * The quote is linked to a customer and optionally to an order.
 * Items are stored as JSONB so they can be re-rendered in WhatsApp.
 */

const { query }   = require('../models/db');
const manager     = require('./manager');
const crm         = require('./crm');
const agentSvc    = require('./agents');
const logger      = require('../utils/logger');

// ── Quote status values ───────────────────────────────────────────────────────

const STATUS = {
  DRAFT:    'draft',
  SENT:     'sent',
  APPROVED: 'approved',
  DECLINED: 'declined',
  INVOICED: 'invoiced',
  EXPIRED:  'expired',
};

// ── Create ────────────────────────────────────────────────────────────────────

/**
 * Create a quote in the local DB and push it to Manager.io.
 * Returns the quote row including its manager_quote_ref.
 *
 * @param {object} params
 * @param {number}        params.customerId   - customers.id
 * @param {string}        params.customerPhone
 * @param {string}        params.customerName
 * @param {Array<object>} params.items        - [{name, qty, price, description}]
 * @param {string}        [params.notes]
 * @param {number}        [params.orderId]    - orders.id if linked to an order
 * @returns {Promise<object>} Quote DB row with manager_quote_ref
 */
const create = async ({ customerId, customerPhone, customerName, items, notes, orderId }) => {
  const total = (items || []).reduce((sum, i) => sum + ((i.qty || 1) * (i.price || 0)), 0);

  // Insert into DB first — we need the local ID for the Manager.io reference
  const res = await query(
    `INSERT INTO quotes (customer_id, order_id, status, items, total_amount, notes)
     VALUES ($1, $2, 'draft', $3, $4, $5)
     RETURNING *`,
    [customerId, orderId || null, JSON.stringify(items || []), total, notes || null]
  );
  const quote = res.rows[0];

  // Push to Manager.io (non-fatal)
  try {
    const managerKey = await manager.upsertCustomer({ phone: customerPhone, name: customerName });
    const quoteRef   = await manager.createQuote({
      customerKey: managerKey,
      quoteId:     quote.id,
      items,
      notes,
    });

    await query(
      `UPDATE quotes SET manager_quote_ref = $1, updated_at = NOW() WHERE id = $2`,
      [quoteRef, quote.id]
    );
    quote.manager_quote_ref = quoteRef;
  } catch (err) {
    logger.warn('quote: manager push failed (non-fatal)', { quoteId: quote.id, error: err.message });
    quote.manager_quote_ref = `WA-QUOTE-${quote.id}`;
  }

  logger.info('quote: created', { quoteId: quote.id, total, customerPhone });
  return quote;
};

// ── Send ──────────────────────────────────────────────────────────────────────

/**
 * Build the WhatsApp message payload for a quote.
 * Returns an interactive buttons message with Approve / Decline options.
 *
 * @param {object} quote  - Quote DB row with items (parsed JSONB)
 * @param {string} customerName
 * @returns {object} WhatsApp interactive payload
 */
const buildWhatsAppMessage = (quote, customerName) => {
  const items = Array.isArray(quote.items) ? quote.items : JSON.parse(quote.items || '[]');
  const lines = items.map((i) => `  • ${i.name} × ${i.qty || 1} — KES ${(i.price || 0).toLocaleString()}`).join('\n');
  const total = parseFloat(quote.total_amount || 0).toLocaleString();

  return {
    type:  'buttons',
    title: `📋 Quote #${quote.id} — Laitor Invest`,
    body:  [
      `Hello ${customerName || 'there'}! Here is your quote:\n`,
      lines,
      `\n*Total: KES ${total}*`,
      `\nRef: ${quote.manager_quote_ref || 'WA-QUOTE-' + quote.id}`,
      `\nPlease tap below to approve or decline.`,
    ].join('\n'),
    footer:  'Valid for 48 hours · Laitor Invest Limited',
    buttons: [
      { id: 'QUOTE_APPROVE', label: '✅ Approve Quote' },
      { id: 'QUOTE_DECLINE', label: '❌ Decline' },
    ],
  };
};

/**
 * Mark a quote as sent and update sent_at timestamp.
 * @param {number} quoteId
 * @returns {Promise<object>} Updated quote row
 */
const markSent = async (quoteId) => {
  const res = await query(
    `UPDATE quotes SET status = 'sent', sent_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
    [quoteId]
  );
  return res.rows[0];
};

// ── Approve ───────────────────────────────────────────────────────────────────

/**
 * Process customer approval of a quote.
 * Actions:
 *   1. Convert quote → invoice in Manager.io
 *   2. Mark quote status = 'approved'
 *   3. Update linked order invoice_ref
 *   4. Advance Twenty CRM opportunity to WON
 *   5. Notify finance agent
 *
 * @param {number} quoteId
 * @param {object} customer  - Customer DB row {id, phone, name, crm_id}
 * @returns {Promise<{quote: object, invoiceRef: string}>}
 */
const approve = async (quoteId, customer) => {
  const qRes = await query(`SELECT * FROM quotes WHERE id = $1`, [quoteId]);
  if (!qRes.rows.length) throw new Error(`Quote #${quoteId} not found`);
  const quote = qRes.rows[0];

  const items = Array.isArray(quote.items) ? quote.items : JSON.parse(quote.items || '[]');

  // Convert to invoice in Manager.io
  const managerKey = await manager.upsertCustomer({ phone: customer.phone, name: customer.name });
  const invoiceRef = await manager.convertQuoteToInvoice({
    managerQuoteRef: quote.manager_quote_ref,
    quoteId:         quote.id,
    customerKey:     managerKey,
    items,
  });

  // Mark quote approved
  await query(
    `UPDATE quotes SET status = 'invoiced', approved_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [quoteId]
  );

  // Update order if linked
  if (quote.order_id) {
    await query(
      `UPDATE orders SET invoice_ref = $1, status = 'confirmed', updated_at = NOW() WHERE id = $2`,
      [invoiceRef, quote.order_id]
    );
  }

  // Advance CRM opportunity to WON
  try {
    const crmPersonId = customer.crm_id || await crm.upsertPerson({ phone: customer.phone, name: customer.name });
    if (crmPersonId) {
      await crm.updateOpportunityStage(crmPersonId, 'WON', invoiceRef);
    }
  } catch (err) {
    logger.warn('quote: CRM stage update failed (non-fatal)', { quoteId, error: err.message });
  }

  // Notify finance agent
  await agentSvc.notifyQuoteApproved({
    phone:   customer.phone,
    name:    customer.name,
    quoteId: quote.id,
    amount:  quote.total_amount,
  });

  logger.info('quote: approved + invoiced', { quoteId, invoiceRef, phone: customer.phone });
  return { quote: { ...quote, status: 'invoiced' }, invoiceRef };
};

// ── Decline ───────────────────────────────────────────────────────────────────

/**
 * Process customer declining a quote.
 * Actions:
 *   1. Mark quote status = 'declined'
 *   2. Advance Twenty CRM opportunity to LOST
 *   3. Notify relevant category agent to follow up
 *
 * @param {number} quoteId
 * @param {object} customer
 * @returns {Promise<object>} Updated quote row
 */
const decline = async (quoteId, customer) => {
  const qRes = await query(`SELECT * FROM quotes WHERE id = $1`, [quoteId]);
  if (!qRes.rows.length) throw new Error(`Quote #${quoteId} not found`);
  const quote = qRes.rows[0];

  await query(
    `UPDATE quotes SET status = 'declined', declined_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [quoteId]
  );

  // Advance CRM to LOST
  try {
    const crmPersonId = customer.crm_id || await crm.upsertPerson({ phone: customer.phone, name: customer.name });
    if (crmPersonId) {
      await crm.updateOpportunityStage(crmPersonId, 'LOST', `Quote #${quoteId} declined by customer`);
    }
  } catch (err) {
    logger.warn('quote: CRM LOST update failed (non-fatal)', { quoteId, error: err.message });
  }

  // Notify agent
  await agentSvc.notifyQuoteDeclined({
    phone:    customer.phone,
    name:     customer.name,
    quoteId:  quote.id,
    category: 'internet',  // TODO: store category on quote
  });

  logger.info('quote: declined', { quoteId, phone: customer.phone });
  return { ...quote, status: 'declined' };
};

// ── Get pending quote for customer ────────────────────────────────────────────

/**
 * Get the most recent sent (awaiting approval) quote for a customer.
 * Used by the orchestrator to handle approve/decline taps.
 *
 * @param {number} customerId
 * @returns {Promise<object|null>}
 */
const getPendingForCustomer = async (customerId) => {
  try {
    const res = await query(
      `SELECT * FROM quotes WHERE customer_id = $1 AND status = 'sent' ORDER BY sent_at DESC LIMIT 1`,
      [customerId]
    );
    return res.rows[0] || null;
  } catch (err) {
    logger.warn('quote: getPendingForCustomer failed', { customerId, error: err.message });
    return null;
  }
};

module.exports = {
  STATUS,
  create,
  buildWhatsAppMessage,
  markSent,
  approve,
  decline,
  getPendingForCustomer,
};
