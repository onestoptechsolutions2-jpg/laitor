'use strict';

const axios  = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

const gql = async (query, variables = {}) => {
  const res = await axios.post(
    `${config.crm.url}/graphql`,
    { query, variables },
    {
      headers: {
        Authorization: `Bearer ${config.crm.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    }
  );
  if (res.data.errors?.length) {
    throw new Error(res.data.errors.map((e) => e.message).join('; '));
  }
  return res.data.data;
};

/**
 * Find existing CRM person by phone. Returns id or null.
 */
const findPersonByPhone = async (phone) => {
  if (!config.crm.url || !config.crm.apiKey) return null;
  try {
    const data = await gql(
      `query FindPerson($phone: StringFilter!) {
        people(filter: { phones: { primaryPhoneNumber: $phone } }) {
          edges { node { id name { firstName lastName } } }
        }
      }`,
      { phone: { eq: phone } }
    );
    return data?.people?.edges?.[0]?.node || null;
  } catch (err) {
    logger.warn('CRM findPersonByPhone failed', { phone, error: err.message });
    return null;
  }
};

/**
 * Create or return existing person. Never creates duplicates.
 */
const upsertPerson = async ({ phone, name }) => {
  if (!config.crm.url || !config.crm.apiKey) return null;
  try {
    const existing = await findPersonByPhone(phone);
    if (existing) {
      logger.debug('CRM person exists', { crmId: existing.id, phone });
      return existing.id;
    }

    const firstName = name ? name.split(' ')[0] : 'Unknown';
    const lastName  = name ? name.split(' ').slice(1).join(' ') : '';

    const createData = await gql(
      `mutation CreatePerson($firstName: String!, $lastName: String!, $phone: String!) {
        createPerson(data: {
          name: { firstName: $firstName, lastName: $lastName }
          phones: { primaryPhoneNumber: $phone, primaryPhoneCountryCode: "KE" }
        }) { id }
      }`,
      { firstName, lastName, phone }
    );
    const id = createData?.createPerson?.id;
    logger.info('CRM person created', { crmId: id, phone });
    return id;
  } catch (err) {
    logger.error('CRM upsertPerson failed', { phone, error: err.message });
    return null;
  }
};

/**
 * Update an existing CRM person's name and/or city (location).
 */
const updatePerson = async (crmPersonId, { name, location }) => {
  if (!config.crm.url || !config.crm.apiKey || !crmPersonId) return;
  try {
    const firstName = name ? name.split(' ')[0] : undefined;
    const lastName  = name ? name.split(' ').slice(1).join(' ') : undefined;

    const fields = [];
    const vars   = { id: crmPersonId };

    if (firstName) {
      fields.push('name: { firstName: $firstName, lastName: $lastName }');
      vars.firstName = firstName;
      vars.lastName  = lastName || '';
    }
    if (location) {
      fields.push('city: $city');
      vars.city = location;
    }
    if (!fields.length) return;

    const paramDefs = [
      '$id: ID!',
      firstName ? '$firstName: String!' : null,
      firstName ? '$lastName: String!' : null,
      location  ? '$city: String!'     : null,
    ].filter(Boolean).join(', ');

    await gql(
      `mutation UpdatePerson(${paramDefs}) {
        updatePerson(id: $id, data: { ${fields.join(', ')} }) { id }
      }`,
      vars
    );
    logger.info('CRM person updated', { crmPersonId, name, location });
  } catch (err) {
    logger.warn('CRM updatePerson failed (non-fatal)', { crmPersonId, error: err.message });
  }
};

const createLead = async ({ crmPersonId, type, notes }) => {
  if (!config.crm.url || !config.crm.apiKey || !crmPersonId) return null;
  try {
    const closeDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const data = await gql(
      `mutation CreateOpportunity($name: String!, $closeDate: DateTime!, $personId: ID!) {
        createOpportunity(data: {
          name: $name
          stage: NEW_LEAD
          closeDate: $closeDate
          pointOfContactId: $personId
        }) { id }
      }`,
      { name: `[${type}] WhatsApp Lead`, closeDate, personId: crmPersonId }
    );
    const id = data?.createOpportunity?.id;
    logger.info('CRM lead created', { crmLeadId: id, type });
    return id;
  } catch (err) {
    logger.error('CRM createLead failed', { error: err.message });
    return null;
  }
};

const logActivity = async ({ crmPersonId, message, direction }) => {
  if (!config.crm.url || !config.crm.apiKey || !crmPersonId) return;
  try {
    await gql(
      `mutation CreateNote($title: String!) {
        createNote(data: { title: $title }) { id }
      }`,
      {
        title: `WhatsApp ${direction === 'in' ? 'IN' : 'OUT'} [${crmPersonId.substring(0, 8)}]: ${message.substring(0, 120)}`,
      }
    );
  } catch (err) {
    logger.warn('CRM logActivity failed', { error: err.message });
  }
};

module.exports = { upsertPerson, updatePerson, findPersonByPhone, createLead, logActivity };
