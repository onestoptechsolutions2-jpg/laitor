'use strict';

const { query } = require('../models/db');
const session = require('../services/session');
const { classify, INTENTS } = require('../services/intent');
const whatsapp = require('../services/whatsapp');
const crm = require('../services/crm');
const logger = require('../utils/logger');

// ─── Response Templates ──────────────────────────────────────────────────────

const REPLIES = {
  [INTENTS.INTERNET_LEAD]: [
    '✅ Thanks for reaching out to *Laitor Invest*!',
    'We\'ve received your internet enquiry and one of our sales team will contact you shortly to discuss the best package for your area.',
    'In the meantime, reply with your *location* so we can check availability. 📍',
  ],
  [INTENTS.PRODUCT_ORDER]: [
    '🛒 Got it! You\'re interested in placing an order.',
    'Please tell us what product you need (e.g. CCTV camera, router) and the *quantity*, and we\'ll prepare a quote for you.',
  ],
  [INTENTS.SUPPORT_REQUEST]: [
    '🔧 We\'re sorry you\'re having trouble.',
    'A support ticket has been logged and our technical team will reach out to you shortly.',
    'Please describe your issue in more detail if you haven\'t already — this helps us resolve it faster.',
  ],
  [INTENTS.GENERAL_INQUIRY]: [
    '👋 Hello! Welcome to *Laitor Invest*.',
    'How can we help you today? You can ask about:\n• 🌐 Internet packages\n• 📦 Products & orders\n• 🔧 Technical support',
  ],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Find or create customer record in local DB.
 */
const upsertCustomer = async (phone, name) => {
  const res = await query(
    `INSERT INTO customers (phone, name)
     VALUES ($1, $2)
     ON CONFLICT (phone)
     DO UPDATE SET name = COALESCE(EXCLUDED.name, customers.name), updated_at = NOW()
     RETURNING *`,
    [phone, name || null]
  );
  return res.rows[0];
};

/**
 * Log message to DB for audit trail.
 */
const logMessage = async ({ phone, direction, text, raw, msgId }) => {
  try {
    await query(
      `INSERT INTO messages (phone, direction, text, raw, msg_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (msg_id) DO NOTHING`,
      [phone, direction, text, JSON.stringify(raw), msgId]
    );
  } catch (err) {
    logger.warn('Message log failed (non-fatal)', { error: err.message });
  }
};

/**
 * Create a lead record in local DB.
 */
const createLocalLead = async (customerId, type, notes, crmLeadId) => {
  const res = await query(
    `INSERT INTO leads (customer_id, type, notes, crm_lead_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [customerId, type, notes, crmLeadId]
  );
  return res.rows[0].id;
};

/**
 * Create a ticket record in local DB.
 */
const createLocalTicket = async (customerId, issue) => {
  const res = await query(
    `INSERT INTO tickets (customer_id, issue)
     VALUES ($1, $2) RETURNING id`,
    [customerId, issue]
  );
  return res.rows[0].id;
};

// ─── Main Orchestrator ───────────────────────────────────────────────────────

/**
 * Process a normalised inbound WhatsApp message.
 *
 * @param {{ phone: string, name: string, text: string, msgId: string, raw: object }} msg
 */
const process = async (msg) => {
  const { phone, name, text, msgId, raw } = msg;
  logger.info('Orchestrator processing message', { phone, msgId });

  // 1. Log inbound message
  await logMessage({ phone, direction: 'in', text, raw, msgId });

  // 2. Upsert customer in local DB
  let customer;
  try {
    customer = await upsertCustomer(phone, name);
  } catch (err) {
    logger.error('Customer upsert failed', { phone, error: err.message });
    // Continue — don't drop the message
    customer = { id: null, phone };
  }

  // 3. Load session
  const sess = await session.get(phone);

  // 4. Classify intent
  const { intent, confidence, matched } = classify(text);
  logger.info('Intent classified', { phone, intent, confidence, matched });

  // 5. Update session with latest intent
  await session.set(phone, { lastIntent: intent, lastMessage: text, customerId: customer.id });

  // 6. Route by intent
  let replies = REPLIES[intent] || REPLIES[INTENTS.GENERAL_INQUIRY];

  try {
    switch (intent) {
      case INTENTS.INTERNET_LEAD:
      case INTENTS.PRODUCT_ORDER: {
        // Upsert CRM person
        const crmPersonId = await crm.upsertPerson({ phone, name });

        if (customer.id) {
          // Update CRM id on customer record
          await query('UPDATE customers SET crm_id = $1 WHERE id = $2', [crmPersonId, customer.id]);
        }

        // Create CRM lead
        const crmLeadId = crmPersonId
          ? await crm.createLead({ crmPersonId, type: intent, notes: text })
          : null;

        // Log in local DB
        if (customer.id) {
          await createLocalLead(customer.id, intent, text, crmLeadId);
        }

        // Log inbound activity in CRM
        if (crmPersonId) {
          await crm.logActivity({ crmPersonId, message: text, direction: 'in' });
        }
        break;
      }

      case INTENTS.SUPPORT_REQUEST: {
        // Create ticket in local DB
        if (customer.id) {
          const ticketId = await createLocalTicket(customer.id, text);
          logger.info('Support ticket created', { ticketId, phone });
        }

        // Optionally create CRM lead for support (for tracking)
        const crmPersonId = await crm.upsertPerson({ phone, name });
        if (crmPersonId) {
          await crm.createLead({ crmPersonId, type: intent, notes: text });
          await crm.logActivity({ crmPersonId, message: text, direction: 'in' });
        }
        break;
      }

      case INTENTS.GENERAL_INQUIRY:
      default:
        // No DB / CRM action for general inquiries — just reply
        break;
    }
  } catch (err) {
    logger.error('Orchestrator route handler error', { intent, phone, error: err.message });
    // Still send a reply — don't leave customer hanging
  }

  // 7. Send WhatsApp replies
  try {
    await whatsapp.sendSequence(phone, replies);
    // Log each outbound message
    for (const r of replies) {
      await logMessage({ phone, direction: 'out', text: r, raw: { automated: true }, msgId: `out-${msgId}-${Date.now()}` });
    }
  } catch (err) {
    logger.error('Failed to send WhatsApp reply', { phone, error: err.message });
  }

  logger.info('Orchestrator done', { phone, intent });
};

module.exports = { process };
