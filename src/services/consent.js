'use strict';

const { query } = require('../models/db');
const logger = require('../utils/logger');

const CONSENT_STATUS = {
  PENDING: 'pending',
  GIVEN:   'given',
  DENIED:  'denied',
};

const CONSENT_MESSAGE = [
  'Hello! This is Laitor Invest Limited.',
  'We would like to send you information about our internet packages, products, and support services via WhatsApp.\n\nPlease reply with:\n*1* - Yes, I accept\n*2* - No, opt out\n\nYou can reply *STOP* at any time to stop receiving messages from us.',
];

/**
 * Get the consent status for a phone number.
 * Returns 'pending' if customer not found.
 */
const getStatus = async (phone) => {
  const res = await query(
    'SELECT consent_status FROM customers WHERE phone = $1',
    [phone]
  );
  return res.rows[0]?.consent_status || CONSENT_STATUS.PENDING;
};

/**
 * Mark a customer as having given consent.
 */
const giveConsent = async (phone) => {
  await query(
    `UPDATE customers
     SET consent_status = 'given', consented_at = NOW(), updated_at = NOW()
     WHERE phone = $1`,
    [phone]
  );
  logger.info('Consent given', { phone });
};

/**
 * Mark a customer as having denied consent (opted out).
 */
const denyConsent = async (phone) => {
  await query(
    `UPDATE customers
     SET consent_status = 'denied', updated_at = NOW()
     WHERE phone = $1`,
    [phone]
  );
  logger.info('Consent denied / opted out', { phone });
};

/**
 * Parse a customer reply to determine if it is a consent response.
 * Returns 'given', 'denied', or null (not a consent reply).
 */
const parseConsentReply = (text) => {
  const t = (text || '').trim().toLowerCase();
  if (t === '1' || t === 'yes' || t === 'accept' || t === 'ok' || t === 'okay') {
    return CONSENT_STATUS.GIVEN;
  }
  if (t === '2' || t === 'no' || t === 'stop' || t === 'opt out' || t === 'optout') {
    return CONSENT_STATUS.DENIED;
  }
  return null;
};

module.exports = {
  CONSENT_STATUS,
  CONSENT_MESSAGE,
  getStatus,
  giveConsent,
  denyConsent,
  parseConsentReply,
};
