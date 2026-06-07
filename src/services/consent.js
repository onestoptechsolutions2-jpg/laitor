'use strict';

const { query } = require('../models/db');
const logger = require('../utils/logger');
const menu   = require('./menu');

const CONSENT_STATUS = {
  PENDING: 'pending',
  GIVEN:   'given',
  DENIED:  'denied',
};

// Interactive consent message (buttons) — imported from menu
const CONSENT_MESSAGE = menu.CONSENT_MESSAGE;

const getStatus = async (phone) => {
  const res = await query('SELECT consent_status FROM customers WHERE phone = $1', [phone]);
  return res.rows[0]?.consent_status || CONSENT_STATUS.PENDING;
};

const giveConsent = async (phone) => {
  await query(
    `UPDATE customers SET consent_status = 'given', consented_at = NOW(), updated_at = NOW() WHERE phone = $1`,
    [phone]
  );
  logger.info('Consent given', { phone });
};

const denyConsent = async (phone) => {
  await query(
    `UPDATE customers SET consent_status = 'denied', updated_at = NOW() WHERE phone = $1`,
    [phone]
  );
  logger.info('Consent denied / opted out', { phone });
};

/**
 * Parse consent reply — works for both typed text and button tap IDs.
 * Button tap sends the buttonId ('1' or '2') as the message text.
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

module.exports = { CONSENT_STATUS, CONSENT_MESSAGE, getStatus, giveConsent, denyConsent, parseConsentReply };
