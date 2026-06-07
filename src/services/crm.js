'use strict';

const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Twenty CRM GraphQL client.
 * Endpoint: POST {CRM_URL}/graphql
 */
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

  if (res.data.errors && res.data.errors.length) {
    const msg = res.data.errors.map((e) => e.message).join('; ');
    throw new Error(`GraphQL error: ${msg}`);
  }

  return res.data.data;
};

const upsertPerson = async ({ phone, name }) => {
  if (!config.crm.url || !config.crm.apiKey) return null;

  try {
    const searchData = await gql(
      `query FindPerson($phone: StringFilter!) {
        people(filter: { phones: { primaryPhoneNumber: $phone } }) {
          edges { node { id } }
        }
      }`,
      { phone: { eq: phone } }
    );

    const existing = searchData?.people?.edges?.[0]?.node;
    if (existing) {
      logger.debug('CRM person found', { crmId: existing.id, phone });
      return existing.id;
    }

    const firstName = name ? name.split(' ')[0] : 'Unknown';
    const lastName  = name ? name.split(' ').slice(1).join(' ') : '';

    const createData = await gql(
      `mutation CreatePerson($firstName: String!, $lastName: String!, $phone: String!) {
        createPerson(data: {
          name: { firstName: $firstName, lastName: $lastName }
          phones: { primaryPhoneNumber: $phone, primaryPhoneCountryCode: "KE" }
        }) {
          id
        }
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
        }) {
          id
        }
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
      `mutation CreateNote($title: String!, $personId: ID!) {
        createNote(data: {
          title: $title
          noteTargets: { createMany: { data: [{ personId: $personId }] } }
        }) {
          id
        }
      }`,
      {
        title: `WhatsApp ${direction === 'in' ? 'Inbound' : 'Outbound'}: ${message.substring(0, 100)}`,
        personId: crmPersonId,
      }
    );
    logger.debug('CRM activity logged', { crmPersonId, direction });
  } catch (err) {
    logger.warn('CRM logActivity failed', { error: err.message });
  }
};

module.exports = { upsertPerson, createLead, logActivity };
