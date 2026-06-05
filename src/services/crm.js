'use strict';

const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Twenty CRM REST client.
 * Docs: https://twenty.com/developers/rest-api
 */
const client = axios.create({
  baseURL: config.crm.url,
  headers: {
    Authorization: `Bearer ${config.crm.apiKey}`,
    'Content-Type': 'application/json',
  },
  timeout: 10000,
});

/**
 * Find or create a "Person" record in Twenty CRM by phone number.
 *
 * @param {{ phone: string, name?: string }} customer
 * @returns {Promise<string>} CRM person ID
 */
const upsertPerson = async ({ phone, name }) => {
  try {
    // Try to find existing person by phone
    const searchRes = await client.get('/objects/people', {
      params: { filter: `phones.primaryPhoneNumber[eq]=${phone}`, limit: 1 },
    });

    const existing = searchRes.data?.data?.people?.[0];
    if (existing) {
      logger.debug('CRM person found', { crmId: existing.id, phone });
      return existing.id;
    }

    // Create new person
    const createRes = await client.post('/objects/people', {
      name: { firstName: name || 'Unknown', lastName: '' },
      phones: { primaryPhoneNumber: phone, primaryPhoneCountryCode: '+254' },
    });

    const created = createRes.data?.data?.createPerson;
    logger.info('CRM person created', { crmId: created?.id, phone });
    return created?.id;
  } catch (err) {
    logger.error('CRM upsertPerson failed', { phone, error: err.message });
    return null; // non-fatal — system continues without CRM id
  }
};

/**
 * Create a lead/opportunity in Twenty CRM.
 *
 * @param {{ crmPersonId: string, type: string, notes: string }} params
 * @returns {Promise<string|null>} CRM opportunity ID
 */
const createLead = async ({ crmPersonId, type, notes }) => {
  try {
    const res = await client.post('/objects/opportunities', {
      name: `[${type}] WhatsApp Lead`,
      stage: 'NEW',
      closeDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // +30 days
      pointOfContactId: crmPersonId,
      notes: { body: notes || '' },
    });

    const id = res.data?.data?.createOpportunity?.id;
    logger.info('CRM lead created', { crmLeadId: id, type });
    return id;
  } catch (err) {
    logger.error('CRM createLead failed', { error: err.message });
    return null;
  }
};

/**
 * Log a note/activity against a CRM person (interaction history).
 *
 * @param {{ crmPersonId: string, message: string, direction: 'in'|'out' }} params
 */
const logActivity = async ({ crmPersonId, message, direction }) => {
  try {
    await client.post('/objects/notes', {
      title: `WhatsApp ${direction === 'in' ? 'Inbound' : 'Outbound'}`,
      body: message,
      noteTargets: {
        create: [{ personId: crmPersonId }],
      },
    });
    logger.debug('CRM activity logged', { crmPersonId, direction });
  } catch (err) {
    // Non-fatal: activity logging should not block message flow
    logger.warn('CRM logActivity failed', { error: err.message });
  }
};

module.exports = { upsertPerson, createLead, logActivity };
