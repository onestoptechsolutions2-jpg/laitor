'use strict';

const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Manager.io Server REST API v2 client.
 *
 * Required env vars:
 *   MANAGER_URL     - full API endpoint, e.g. http://finance360.laitor.co.ke/api2
 *   MANAGER_API_KEY - access token from Manager.io Settings → API
 *
 * MANAGER_BUSINESS_KEY is NOT needed for the v2 API format.
 */

const isConfigured = () => !!(config.manager.url && config.manager.apiKey);

const client = () =>
  axios.create({
    baseURL: config.manager.url,   // already the full endpoint, e.g. http://finance360.laitor.co.ke/api2
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
    const res = await client().get('/customers');
    const customers = Array.isArray(res.data) ? res.data : [];

    const existing = customers.find(
      (c) =>
        c.CustomFields?.some?.((f) => f.Value === phone) ||
        c.Name?.includes(phone)
    );

    if (existing) {
      logger.debug('Manager customer found', { key: existing.key, phone });
      return existing.key;
    }

    const createRes = await client().post('/customers', {
      Name: name || phone,
      CustomFields: [{ CustomField: 'Phone', Value: phone }],
    });

    const key = createRes.data?.key;
    logger.info('Manager customer created', { key, phone });
    return key;
  } catch (err) {
    logger.warn('Manager upsertCustomer failed (non-fatal)', {
      phone, error: err.message,
    });
    return null;
  }
};

/**
 * Create a Sales Invoice in Manager.io for a confirmed order.
 */
const createInvoice = async ({ customerKey, orderId, product, phone }) => {
  if (!isConfigured()) {
    logger.warn('Manager.io not configured — skipping invoice');
    return null;
  }

  try {
    const today     = new Date().toISOString().split('T')[0];
    const reference = `WA-ORDER-${orderId}`;

    const body = {
      Date:      today,
      Reference: reference,
      ...(customerKey ? { Customer: customerKey } : {}),
      Lines: [{ Description: product, Qty: 1, UnitPrice: 0 }],
    };

    const res       = await client().post('/sales-invoices', body);
    const invoiceKey = res.data?.key;

    logger.info('Manager invoice created', { invoiceKey, reference, orderId, product, phone });
    return invoiceKey || reference;
  } catch (err) {
    logger.warn('Manager createInvoice failed (non-fatal)', {
      orderId, error: err.message,
    });
    return null;
  }
};

/**
 * Fetch inventory items for the catalog.
 * Tries /inventory-items then /items.
 */
const getInventoryItems = async () => {
  if (!isConfigured()) return [];

  for (const path of ['/inventory-items', '/items']) {
    try {
      const res = await client().get(path);
      const data = Array.isArray(res.data) ? res.data : [];
      if (data.length > 0) {
        logger.info('Manager inventory fetched', { count: data.length, path });
        return data;
      }
    } catch (_) {}
  }

  logger.warn('Manager inventory fetch returned no items');
  return [];
};

module.exports = { upsertCustomer, createInvoice, getInventoryItems };
