'use strict';

const { query } = require('../models/db');
const whatsapp = require('./whatsapp');
const consent  = require('./consent');
const menu     = require('./menu');
const logger   = require('../utils/logger');

/**
 * Rate-limited bulk WhatsApp blast for un-consented contacts.
 * Sends the consent request message at ~3 messages/second max.
 */

const BATCH_DELAY_MS  = 350;  // ms between messages (~3/sec)
const BATCH_SIZE      = 50;   // contacts per batch run

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Load contacts that still need consent (status = 'pending').
 * Optionally filter by territory or cluster.
 */
const getPendingContacts = async ({ territory, cluster, limit } = {}) => {
  const conditions = [`consent_status = 'pending'`];
  const params     = [];

  if (territory) {
    params.push(territory);
    conditions.push(`territory = $${params.length}`);
  }
  if (cluster) {
    params.push(cluster);
    conditions.push(`cluster = $${params.length}`);
  }

  params.push(limit || BATCH_SIZE);
  const sql = `
    SELECT id, phone, name, territory, cluster, service_tag
    FROM customers
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at ASC
    LIMIT $${params.length}
  `;

  const res = await query(sql, params);
  return res.rows;
};

/**
 * Send consent request to a single contact.
 * Marks them as 'pending' (already default) but logs attempt.
 */
const sendConsentRequest = async (contact) => {
  try {
    const name = contact.name || 'valued customer';
    const greeting = `Hello ${name}!`;
    const messages = [
      greeting,
      ...menu.MAIN_MENU, // replaced below with consent-specific message
    ];

    // Use consent-specific message instead of main menu
    await whatsapp.sendText(contact.phone, consent.CONSENT_MESSAGE[0]);
    await sleep(400);
    await whatsapp.sendText(contact.phone, consent.CONSENT_MESSAGE[1]);

    logger.info('Consent request sent', { phone: contact.phone, name: contact.name });
    return true;
  } catch (err) {
    logger.warn('Consent send failed', { phone: contact.phone, error: err.message });
    return false;
  }
};

/**
 * Run a bulk outreach blast.
 * Returns { sent, failed, total } stats.
 */
const runBlast = async ({ territory, cluster } = {}) => {
  logger.info('Starting outreach blast', { territory, cluster });

  const contacts = await getPendingContacts({ territory, cluster, limit: BATCH_SIZE });

  if (!contacts.length) {
    logger.info('No pending contacts for outreach', { territory, cluster });
    return { sent: 0, failed: 0, total: 0 };
  }

  let sent   = 0;
  let failed = 0;

  for (const contact of contacts) {
    const ok = await sendConsentRequest(contact);
    if (ok) { sent++; } else { failed++; }
    await sleep(BATCH_DELAY_MS);
  }

  logger.info('Outreach blast complete', { sent, failed, total: contacts.length });
  return { sent, failed, total: contacts.length };
};

module.exports = { runBlast, getPendingContacts, sendConsentRequest };
