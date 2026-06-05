'use strict';

const whatsapp = require('./whatsapp');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Admin phone numbers to notify.
 * Comma-separated in env: ADMIN_PHONES=2547XXXXXXXX,2547YYYYYYYY
 */
const getAdminPhones = () => {
  const raw = process.env.ADMIN_PHONES || '';
  return raw.split(',').map((p) => p.trim()).filter(Boolean);
};

/**
 * Send a notification to all admin numbers.
 *
 * @param {string} message
 */
const notify = async (message) => {
  const phones = getAdminPhones();
  if (!phones.length) {
    logger.warn('No ADMIN_PHONES configured — skipping admin notification');
    return;
  }
  for (const phone of phones) {
    try {
      await whatsapp.sendText(phone, message);
    } catch (err) {
      logger.error('Admin notification failed', { phone, error: err.message });
    }
  }
};

// ─── Notification Templates ──────────────────────────────────────────────────

/**
 * New support ticket alert.
 */
const notifyNewTicket = async ({ ticketId, phone, name, issue, priority }) => {
  const msg =
    `🔧 *NEW SUPPORT TICKET #${ticketId}*\n` +
    `👤 Customer: ${name || 'Unknown'} (${phone})\n` +
    `⚠️ Priority: ${priority.toUpperCase()}\n` +
    `📝 Issue: ${issue}\n\n` +
    `Reply: TICKET#${ticketId} ASSIGNED [technician name]\n` +
    `       TICKET#${ticketId} RESOLVED`;
  await notify(msg);
};

/**
 * New order alert.
 */
const notifyNewOrder = async ({ orderId, phone, name, product, notes }) => {
  const msg =
    `🛒 *NEW ORDER #${orderId}*\n` +
    `👤 Customer: ${name || 'Unknown'} (${phone})\n` +
    `📦 Product: ${product}\n` +
    (notes ? `📝 Notes: ${notes}\n` : '') +
    `\nReply: ORDER#${orderId} CONFIRMED\n` +
    `       ORDER#${orderId} FULFILLED`;
  await notify(msg);
};

/**
 * New internet lead alert.
 */
const notifyNewLead = async ({ leadId, phone, name, message }) => {
  const msg =
    `🌐 *NEW INTERNET LEAD #${leadId}*\n` +
    `👤 Customer: ${name || 'Unknown'} (${phone})\n` +
    `💬 Message: "${message}"\n\n` +
    `Action: Call customer to discuss package & location.`;
  await notify(msg);
};

module.exports = { notify, notifyNewTicket, notifyNewOrder, notifyNewLead };
