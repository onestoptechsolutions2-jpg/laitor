'use strict';

/**
 * @module manager
 * @description Manager.io Server REST API v2 client.
 *
 * Manager.io is the finance/accounts layer for Laitor. It owns:
 *   - Customers (with phone as custom field)
 *   - Inventory items (products & internet packages)
 *   - Sales Quotes (sent to customer for approval)
 *   - Sales Invoices (auto-created after customer approves a quote)
 *
 * Required env vars:
 *   MANAGER_URL          -- full HTTPS API2 endpoint, e.g. https://finance360.laitor.co.ke/api2
 *   MANAGER_API_KEY      -- API key from Manager.io Settings -> API
 *                           Sent as X-API-KEY header (NOT Authorization: Bearer).
 *                           Use the standard Base64 key exactly as shown in Manager.io.
 *   MANAGER_BUSINESS_KEY -- UUID of the Manager.io business.
 *                           Find it in the URL when logged in:
 *                           https://finance360.laitor.co.ke/#/{BUSINESS_UUID}/Dashboard
 *
 * All functions are non-fatal: failures are logged and null/[] returned
 * so the WhatsApp flow is never blocked by a finance API error.
 */

const axios  = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

// ---- Helpers -----------------------------------------------------------------

/**
 * Returns true only if MANAGER_URL, MANAGER_API_KEY, and MANAGER_BUSINESS_KEY are all set.
 * @returns {boolean}
 */
const isConfigured = () =>
  !!(config.manager.url && config.manager.apiKey && config.manager.businessKey);

/**
 * Creates a pre-configured axios instance for Manager.io API v2.
 * Uses X-API-KEY header as required by Manager.io Server OpenAPI spec.
 * Base URL includes the business key: {MANAGER_URL}/{MANAGER_BUSINESS_KEY}
 * @returns {import('axios').AxiosInstance}
 */
const client = () =>
  axios.create({
    baseURL: config.manager.url + '/' + config.manager.businessKey,
    headers: {
      'X-API-KEY':     config.manager.apiKey,
      'Content-Type':  'application/json',
    },
    timeout:      15000,
    maxRedirects: 0,
  });

// ---- Customers ---------------------------------------------------------------

/**
 * Find or create a Customer record in Manager.io by phone number.
 * Matching is done against a custom field named 'Phone' and against Name.
 *
 * @param {object} params
 * @param {string} params.phone  - E.164-ish phone, e.g. '254712345678'
 * @param {string} [params.name] - Customer display name (falls back to phone)
 * @returns {Promise<string|null>} Manager.io customer key, or null on failure
 */
const upsertCustomer = async ({ phone, name }) => {
  if (!isConfigured()) return null;

  try {
    const res       = await client().get('/customers');
    const customers = Array.isArray(res.data) ? res.data : [];

    const existing = customers.find(
      (c) =>
        c.CustomFields?.some?.((f) => f.Value === phone) ||
        c.Name?.includes(phone)
    );

    if (existing) {
      logger.debug('Manager: customer found', { key: existing.key, phone });
      return existing.key;
    }

    const createRes = await client().post('/customers', {
      Name:         name || phone,
      CustomFields: [{ CustomField: 'Phone', Value: phone }],
    });

    const key = createRes.data?.key;
    logger.info('Manager: customer created', { key, phone });
    return key;
  } catch (err) {
    logger.warn('Manager: upsertCustomer failed (non-fatal)', { phone, error: err.message });
    return null;
  }
};

// ---- Quotes ------------------------------------------------------------------

/**
 * Create a Sales Quote in Manager.io for a pending order.
 *
 * @param {object} params
 * @param {string}        params.customerKey  - Manager.io customer key
 * @param {number}        params.quoteId      - Local DB quotes.id
 * @param {Array<object>} params.items        - [{name, qty, price}]
 * @param {string}        [params.notes]      - Optional quote notes
 * @returns {Promise<string|null>} Manager.io quote reference string, or null on failure
 */
const createQuote = async ({ customerKey, quoteId, items, notes }) => {
  if (!isConfigured()) {
    logger.warn('Manager: not configured -- skipping quote creation');
    return 'WA-QUOTE-' + quoteId;
  }

  try {
    const today     = new Date().toISOString().split('T')[0];
    const reference = 'WA-QUOTE-' + quoteId;

    const body = {
      Date:      today,
      Reference: reference,
      ...(customerKey ? { Customer: customerKey } : {}),
      ...(notes        ? { Description: notes }   : {}),
      Lines: (items || []).map((item) => ({
        Description: item.name || item.description || 'Service',
        Qty:         item.qty   || 1,
        UnitPrice:   item.price || 0,
      })),
    };

    const res      = await client().post('/sales-quotes', body);
    const quoteRef = res.data?.key || reference;

    logger.info('Manager: quote created', { quoteRef, reference, quoteId });
    return quoteRef;
  } catch (err) {
    logger.warn('Manager: createQuote failed (non-fatal)', { quoteId, error: err.message });
    return 'WA-QUOTE-' + quoteId;
  }
};

/**
 * Convert an approved quote into a Sales Invoice in Manager.io.
 *
 * @param {object} params
 * @param {string} params.managerQuoteRef  - The reference returned by createQuote()
 * @param {number} params.quoteId          - Local DB quotes.id
 * @param {string} params.customerKey      - Manager.io customer key
 * @param {Array}  params.items            - Quote line items [{name, qty, price}]
 * @returns {Promise<string|null>} Invoice reference string, or null on failure
 */
const convertQuoteToInvoice = async ({ managerQuoteRef, quoteId, customerKey, items }) => {
  if (!isConfigured()) {
    logger.warn('Manager: not configured -- skipping invoice creation');
    return 'WA-INV-' + quoteId;
  }

  try {
    const today  = new Date().toISOString().split('T')[0];
    const invRef = 'WA-INV-' + quoteId;

    const body = {
      Date:        today,
      Reference:   invRef,
      ...(customerKey ? { Customer: customerKey } : {}),
      Description: 'Converted from quote ' + managerQuoteRef,
      Lines: (items || []).map((item) => ({
        Description: item.name || item.description || 'Service',
        Qty:         item.qty   || 1,
        UnitPrice:   item.price || 0,
      })),
    };

    const res        = await client().post('/sales-invoices', body);
    const invoiceKey = res.data?.key || invRef;

    logger.info('Manager: invoice created from quote', { invoiceKey, managerQuoteRef, quoteId });
    return invoiceKey;
  } catch (err) {
    logger.warn('Manager: convertQuoteToInvoice failed (non-fatal)', { quoteId, error: err.message });
    return 'WA-INV-' + quoteId;
  }
};

// ---- Direct invoice (admin-confirmed orders) ---------------------------------

/**
 * Create a Sales Invoice directly (used when an admin confirms an order without a quote flow).
 *
 * @param {object} params
 * @param {string} params.customerKey  - Manager.io customer key
 * @param {number} params.orderId      - Local DB orders.id
 * @param {string} params.product      - Product/service name
 * @param {string} params.phone        - Customer phone (for logging)
 * @returns {Promise<string|null>} Invoice key/reference, or null on failure
 */
const createInvoice = async ({ customerKey, orderId, product, phone }) => {
  if (!isConfigured()) {
    logger.warn('Manager: not configured -- skipping invoice');
    return null;
  }

  try {
    const today     = new Date().toISOString().split('T')[0];
    const reference = 'WA-ORDER-' + orderId;

    const body = {
      Date:      today,
      Reference: reference,
      ...(customerKey ? { Customer: customerKey } : {}),
      Lines: [{ Description: product, Qty: 1, UnitPrice: 0 }],
    };

    const res        = await client().post('/sales-invoices', body);
    const invoiceKey = res.data?.key;

    logger.info('Manager: invoice created', { invoiceKey, reference, orderId, product, phone });
    return invoiceKey || reference;
  } catch (err) {
    logger.warn('Manager: createInvoice failed (non-fatal)', { orderId, error: err.message });
    return null;
  }
};

// ---- Inventory / Catalog -----------------------------------------------------

/**
 * Fetch inventory items from Manager.io for use in the WhatsApp catalog menu.
 * Tries /inventory-items first, falls back to /items.
 * Returns an empty array (never throws).
 *
 * @returns {Promise<Array>}
 */
const getInventoryItems = async () => {
  if (!isConfigured()) return [];

  for (var i = 0; i < 2; i++) {
    var path = i === 0 ? '/inventory-items' : '/items';
    try {
      const res  = await client().get(path);
      const data = Array.isArray(res.data) ? res.data : [];
      if (data.length > 0) {
        logger.info('Manager: inventory fetched', { count: data.length, path: path });
        return data;
      }
    } catch (_) { /* try next path */ }
  }

  logger.warn('Manager: inventory fetch returned no items');
  return [];
};

module.exports = {
  isConfigured,
  upsertCustomer,
  createQuote,
  convertQuoteToInvoice,
  createInvoice,
  getInventoryItems,
};
