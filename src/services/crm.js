'use strict';

/**
 * @module crm
 * @description Twenty CRM GraphQL API client.
 *
 * Twenty CRM is the sales pipeline layer for Laitor. It owns:
 *   - People (contacts, linked by phone as unique key)
 *   - Opportunities (leads, with stage progression)
 *   - Notes (activity log, interaction history)
 *
 * All functions are non-fatal: failures are logged and null returned
 * so the WhatsApp flow is never blocked by a CRM API error.
 *
 * Required env vars:
 *   CRM_URL     — Twenty instance URL, NO trailing slash, e.g. https://crm.laitor.co.ke
 *   CRM_API_KEY — API key from Twenty → Settings → API & Webhooks
 *
 * CRM Stage values (valid in Twenty):
 *   NEW_LEAD | CONTACTED | MEETING_SCHEDULED | PROPOSAL_SENT |
 *   NEGOTIATION | WON | LOST
 */

const axios  = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

// ── GraphQL executor ──────────────────────────────────────────────────────────

/**
 * Execute a GraphQL query/mutation against the Twenty CRM API.
 * Throws if the response contains GraphQL errors.
 *
 * @param {string} query      - GraphQL query/mutation string
 * @param {object} [variables]
 * @returns {Promise<object>} data field of the GraphQL response
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
  if (res.data.errors?.length) {
    throw new Error(res.data.errors.map((e) => e.message).join('; '));
  }
  return res.data.data;
};

// ── Guarded wrapper — always non-fatal ───────────────────────────────────────

/**
 * Execute a CRM operation safely — logs and returns null on failure.
 * @param {Function} fn
 * @param {string}   label  - For log messages
 */
const safe = async (fn, label) => {
  if (!config.crm.url || !config.crm.apiKey) return null;
  try { return await fn(); }
  catch (err) {
    logger.warn(`CRM ${label} failed (non-fatal)`, { error: err.message });
    return null;
  }
};

// ── People ────────────────────────────────────────────────────────────────────

/**
 * Find an existing CRM Person by phone number.
 * Phone is the universal key — used to prevent duplicates across all sources.
 *
 * @param {string} phone - E.164-ish, e.g. '254712345678'
 * @returns {Promise<{id: string, name: object}|null>}
 */
const findPersonByPhone = async (phone) => safe(async () => {
  const data = await gql(
    `query FindPerson($phone: StringFilter!) {
       people(filter: { phones: { primaryPhoneNumber: $phone } }) {
         edges { node { id name { firstName lastName } } }
       }
     }`,
    { phone: { eq: phone } }
  );
  return data?.people?.edges?.[0]?.node || null;
}, 'findPersonByPhone');

/**
 * Find or create a CRM Person by phone. Never creates duplicates.
 * Returns the Twenty person ID, or null if CRM is unreachable.
 *
 * @param {object} params
 * @param {string} params.phone
 * @param {string} [params.name]
 * @returns {Promise<string|null>} Twenty person ID
 */
const upsertPerson = async ({ phone, name }) => safe(async () => {
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
}, 'upsertPerson');

/**
 * Update an existing CRM Person's name and/or city (location).
 * Called after KYC collection.
 *
 * @param {string} crmPersonId
 * @param {object} updates   - { name?, location? }
 * @returns {Promise<void>}
 */
const updatePerson = async (crmPersonId, { name, location }) => safe(async () => {
  if (!crmPersonId) return;

  const firstName = name ? name.split(' ')[0] : undefined;
  const lastName  = name ? name.split(' ').slice(1).join(' ') : undefined;

  const fields   = [];
  const vars     = { id: crmPersonId };
  const paramArr = ['$id: ID!'];

  if (firstName) {
    fields.push('name: { firstName: $firstName, lastName: $lastName }');
    vars.firstName = firstName;
    vars.lastName  = lastName || '';
    paramArr.push('$firstName: String!', '$lastName: String!');
  }
  if (location) {
    fields.push('city: $city');
    vars.city = location;
    paramArr.push('$city: String!');
  }
  if (!fields.length) return;

  await gql(
    `mutation UpdatePerson(${paramArr.join(', ')}) {
       updatePerson(id: $id, data: { ${fields.join(', ')} }) { id }
     }`,
    vars
  );
  logger.info('CRM person updated', { crmPersonId, name, location });
}, 'updatePerson');

// ── Opportunities ─────────────────────────────────────────────────────────────

/**
 * Create a new Opportunity (lead) in Twenty CRM.
 * Stage starts at NEW_LEAD.
 * Close date defaults to 30 days out.
 *
 * @param {object} params
 * @param {string} params.crmPersonId  - Twenty person ID
 * @param {string} params.type         - Lead type, e.g. 'INTERNET_LEAD', 'PRODUCT_ORDER'
 * @param {string} [params.notes]      - Optional notes
 * @returns {Promise<string|null>} Opportunity ID
 */
const createLead = async ({ crmPersonId, type, notes }) => safe(async () => {
  if (!crmPersonId) return null;
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
}, 'createLead');

/**
 * Advance a CRM opportunity to a new stage.
 * Used when: quote sent → PROPOSAL_SENT, approved → WON, declined → LOST.
 *
 * Valid stages: NEW_LEAD | CONTACTED | MEETING_SCHEDULED | PROPOSAL_SENT |
 *               NEGOTIATION | WON | LOST
 *
 * @param {string} crmPersonId   - Twenty person ID (used to find their opportunities)
 * @param {string} stage         - New stage value
 * @param {string} [note]        - Optional note to attach (e.g. invoice reference)
 * @returns {Promise<string|null>} Opportunity ID
 */
const updateOpportunityStage = async (crmPersonId, stage, note) => safe(async () => {
  if (!crmPersonId) return null;

  // Find the most recent opportunity for this person
  const data = await gql(
    `query GetOpportunities($personId: IDFilter!) {
       opportunities(
         filter: { pointOfContactId: $personId }
         orderBy: { createdAt: DescNullsLast }
       ) {
         edges { node { id stage } }
       }
     }`,
    { personId: { eq: crmPersonId } }
  );

  const opp = data?.opportunities?.edges?.[0]?.node;
  if (!opp) {
    logger.warn('CRM: no opportunity found for person', { crmPersonId });
    return null;
  }

  const updated = await gql(
    `mutation UpdateOpportunity($id: ID!, $stage: OpportunityStageEnum!) {
       updateOpportunity(id: $id, data: { stage: $stage }) { id stage }
     }`,
    { id: opp.id, stage }
  );

  if (note) {
    await logActivity({ crmPersonId, message: note, direction: 'out' }).catch(() => {});
  }

  logger.info('CRM opportunity stage updated', { oppId: opp.id, stage, note });
  return updated?.updateOpportunity?.id;
}, 'updateOpportunityStage');

// ── Notes / Activity log ──────────────────────────────────────────────────────

/**
 * Log a WhatsApp interaction as a Note in Twenty CRM.
 *
 * @param {object} params
 * @param {string} params.crmPersonId
 * @param {string} params.message     - Message or activity description
 * @param {string} params.direction   - 'in' | 'out'
 * @returns {Promise<void>}
 */
const logActivity = async ({ crmPersonId, message, direction }) => safe(async () => {
  if (!crmPersonId) return;
  await gql(
    `mutation CreateNote($title: String!) {
       createNote(data: { title: $title }) { id }
     }`,
    {
      title: `WhatsApp ${direction === 'in' ? 'IN' : 'OUT'} [${crmPersonId.substring(0, 8)}]: ${(message || '').substring(0, 120)}`,
    }
  );
}, 'logActivity');

module.exports = {
  findPersonByPhone,
  upsertPerson,
  updatePerson,
  createLead,
  updateOpportunityStage,
  logActivity,
};
