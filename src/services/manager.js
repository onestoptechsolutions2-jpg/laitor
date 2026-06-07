'use strict';

const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Manager.io Server REST API client.
 *
 * Required env vars:
 *   MANAGER_URL          - e.g. https://manager.laitor.co.ke
 *   MANAGER_API_KEY      - API key from Manager.io Settings → API
 *   MANAGER_BUSINESS_KEY - Business GUID from Manager.io Settings
 */

const isConfigured = () =>
  !!(config.manager.url && config.manager.apiKey && config.manager.businessKey);

const client = () =>
  axios.create({
    baseURL: `${config.manager.url}/api/${config.manager.businessKey}`,
    headers: {
      Authorization: config.manager.apiKey,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });

/**
 * Find or create a Customer in Manager.io by phone number.
 * Returns the Manager.io customer key (string) or null.
 */
const upsertCustomer = async ({ phone, name }) => {
  if (!isConfigured()) return null;

  try {
    // Search for existing customer
    const res = await client().get('/customers');
    const customers = res.data || [];

    const existing = customers.find(
      (c) =>
        c.CustomFields?.some?.((f) => f.Value === phone) ||
        c.Name?.includes(phone)
    );

    if (existing) {
      logger.debug('Manager customer found', { key: existing.key, phone });
      return existing.key;
    }

    // Create new customer
    const createRes = await client().post('/customers', {
      Name: name || phone,
      CustomFields: [{ CustomField: 'Phone', Value: phone }],
    });

    const key = createRes.data?.key;
    logger.info('Manager customer created', { key, phone });
    return key;
  } catch (err) {
    logger.error('Manager upsertCustomer failed', {
      phone,
      error: err.message,
      response: err.response?.data,
    });
    return null;
  }
};

/**
 * Create a Sales Invoice in Manager.io for a confirmed order.
 *
 * @param {{ customerKey: string, orderId: number, product: string, phone: string }} params
 * @returns {Promise<string|null>} Invoice reference or null
 */
const createInvoice = async ({ customerKey, orderId, product, phone }) => {
  if (!isConfigured()) {
    logger.warn('Manager.io not configured — skipping invoice creation');
    return null;
  }

  try {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const reference = `WA-ORDER-${orderId}`;

    const body = {
      Date: today,
      Reference: reference,
      ...(customerKey ? { Customer: customerKey } : {}),
      Lines: [
        {
          Description: product,
          Qty: 1,
          UnitPrice: 0, // Price to be filled manually
        },
      ],
    };

    const res = await client().post('/sales-invoices', body);
    const invoiceKey = res.data?.key;

    logger.info('Manager invoice created', {
      invoiceKey,
      reference,
      orderId,
      product,
      phone,
    });

    return invoiceKey || reference;
  } catch (err) {
    logger.error('Manager createInvoice failed', {
      orderId,
      error: err.message,
      response: err.response?.data,
    });
    return null;
  }
};

module.exports = { upsertCustomer, createInvoice };
