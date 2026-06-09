'use strict';

/**
 * @module marketplace/fetcher
 * @description Pluggable product fetcher — pulls products from external sources,
 * applies markup rules, and syncs into the local products catalog.
 *
 * Supported source types:
 *   manual     - No fetching (admin-entered products)
 *   csv        - Upload a CSV file with product data
 *   jumia      - Scrape Jumia Kenya via their public search API / HTML
 *   aliexpress - AliExpress affiliate API (requires API key)
 *   amazon     - Amazon Product Advertising API (requires credentials)
 *   custom_api - Generic JSON REST endpoint (configurable)
 *
 * All fetchers are NON-FATAL — errors are caught and logged.
 * Sync results are recorded on the product_sources row (last_sync, stats).
 */

const axios   = require('axios');
const { query }  = require('../../models/db');
const catalog = require('./catalog');
const logger  = require('../../utils/logger');

// ── Source registry ───────────────────────────────────────────────────────────

const getSources = async (activeOnly = true) => {
  const res = await query(
    `SELECT * FROM product_sources ${activeOnly ? "WHERE active = true" : ''} ORDER BY id`
  );
  return res.rows;
};

const getSource = async (id) => {
  const res = await query(`SELECT * FROM product_sources WHERE id = $1`, [id]);
  return res.rows[0] || null;
};

const upsertSource = async ({ id, name, type, config, active }) => {
  if (id) {
    const res = await query(
      `UPDATE product_sources SET name=$1, type=$2, config=$3, active=$4 WHERE id=$5 RETURNING *`,
      [name, type, JSON.stringify(config || {}), active !== false, id]
    );
    return res.rows[0];
  }
  const res = await query(
    `INSERT INTO product_sources (name, type, config, active) VALUES ($1,$2,$3,$4) RETURNING *`,
    [name, type, JSON.stringify(config || {}), active !== false]
  );
  return res.rows[0];
};

// ── Normalise price to KES ───────────────────────────────────────────────────

const toKES = (amount, fromCurrency = 'KES') => {
  // Exchange rates — update periodically or pull from config
  const rates = { KES: 1, USD: 130, EUR: 140, CNY: 18, GBP: 165 };
  return Math.round(parseFloat(amount || 0) * (rates[fromCurrency] || 1));
};

// ── Jumia Kenya fetcher ───────────────────────────────────────────────────────

/**
 * Fetch products from Jumia Kenya catalog via their public search endpoint.
 * NOTE: This uses Jumia's public catalogue JSON — no auth required.
 * Respectful rate-limiting applied.
 *
 * @param {object} source - product_sources row
 * @param {object} cfg    - source.config: { category_url, max_pages, category_id }
 */
const fetchJumia = async (source, cfg) => {
  const items     = [];
  const maxPages  = parseInt(cfg.max_pages || 3);
  const searchUrl = cfg.search_url || 'https://www.jumia.co.ke/catalog/?q=';
  const keywords  = cfg.keywords   || [];

  if (!keywords.length) {
    logger.warn('fetcher/jumia: no keywords configured');
    return [];
  }

  for (const kw of keywords.slice(0, 5)) {  // max 5 keyword sets per sync
    for (let page = 1; page <= maxPages; page++) {
      try {
        // Jumia has a JSON API for catalog pages
        const url = `https://www.jumia.co.ke/api/v1/listing/?q=${encodeURIComponent(kw)}&page=${page}`;
        const res = await axios.get(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LaitorBot/1.0)' },
          timeout: 15000,
        });
        const products = res.data?.products || res.data?.hits || [];
        if (!products.length) break;

        for (const p of products) {
          items.push({
            source_id:    source.id,
            external_id:  String(p.sku || p.id || p.itemId || ''),
            category_id:  cfg.category_id || null,
            name:         p.name || p.title || '',
            description:  p.description || '',
            image_url:    p.image || p.imageUrl || p.main_image || '',
            cost_price:   toKES(p.price?.current || p.price || 0, 'KES'),
            currency:     'KES',
            supplier_url: `https://www.jumia.co.ke/${p.url || ''}`,
            shipping_info: 'Ships via Jumia (1-5 business days in Kenya)',
            stock_status: p.availability === 'out_of_stock' ? 'out_of_stock' : 'in_stock',
          });
        }
        // Be polite
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        logger.warn('fetcher/jumia: page fetch failed', { kw, page, error: err.message });
        break;
      }
    }
  }
  return items;
};

// ── AliExpress fetcher ────────────────────────────────────────────────────────

/**
 * Fetch products via AliExpress Affiliate API or unofficial endpoint.
 * cfg: { app_key, app_secret, keywords: [], category_id, max_items }
 */
const fetchAliExpress = async (source, cfg) => {
  const items = [];
  if (!cfg.app_key) {
    logger.warn('fetcher/aliexpress: app_key not configured');
    return [];
  }

  const keywords = cfg.keywords || [];
  for (const kw of keywords.slice(0, 5)) {
    try {
      // AliExpress Affiliate API - product search
      const timestamp = Date.now();
      const url = 'https://api-sg.aliexpress.com/sync';
      const params = {
        method:        'aliexpress.affiliate.product.query',
        app_key:       cfg.app_key,
        timestamp,
        sign_method:   'sha256',
        fields:        'product_id,product_title,target_sale_price,target_original_price,product_main_image_url,product_detail_url,first_level_category_name,evaluate_rate,30day_orders',
        keywords:      kw,
        page_no:       1,
        page_size:     cfg.max_items || 20,
        target_currency: 'USD',
        target_language: 'EN',
        tracking_id:   cfg.tracking_id || 'laitor',
      };

      const res = await axios.get(url, { params, timeout: 15000 });
      const data = res.data?.aliexpress_affiliate_product_query_response?.resp_result;
      const products = data?.result?.products?.product || [];

      for (const p of products) {
        const costUsd = parseFloat(p.target_sale_price || p.target_original_price || 0);
        items.push({
          source_id:    source.id,
          external_id:  String(p.product_id),
          category_id:  cfg.category_id || null,
          name:         p.product_title || '',
          image_url:    p.product_main_image_url || '',
          cost_price:   toKES(costUsd, 'USD'),
          currency:     'KES',
          supplier_url: p.product_detail_url || '',
          shipping_info: 'Ships from China (7-21 business days)',
          attributes:   { rating: p.evaluate_rate, orders: p['30day_orders'] },
          stock_status: 'in_stock',
        });
      }
    } catch (err) {
      logger.warn('fetcher/aliexpress: fetch failed', { kw, error: err.message });
    }
  }
  return items;
};

// ── Amazon fetcher ────────────────────────────────────────────────────────────

/**
 * Fetch products via Amazon Product Advertising API v5.
 * cfg: { access_key, secret_key, partner_tag, keywords: [], category_id }
 */
const fetchAmazon = async (source, cfg) => {
  const items = [];
  if (!cfg.access_key || !cfg.secret_key) {
    logger.warn('fetcher/amazon: credentials not configured');
    return [];
  }

  // Amazon PAAPI requires signed requests — simplified implementation
  // Full SigV4 signing would be needed in production
  const keywords = cfg.keywords || [];
  for (const kw of keywords.slice(0, 3)) {
    try {
      const body = {
        Keywords:     kw,
        Resources:    [
          'Images.Primary.Large', 'ItemInfo.Title',
          'Offers.Listings.Price', 'DetailPageURL',
        ],
        PartnerTag:   cfg.partner_tag || '',
        PartnerType:  'Associates',
        SearchIndex:  cfg.search_index || 'All',
        Marketplace:  'www.amazon.com',
      };

      // NOTE: In production, sign this with AWS SigV4
      // For now log a warning and return mock structure hint
      logger.warn('fetcher/amazon: SigV4 signing not implemented — configure custom_api source instead');
      // Placeholder: add real signing or use amazon-paapi npm package
      break;
    } catch (err) {
      logger.warn('fetcher/amazon: fetch failed', { kw, error: err.message });
    }
  }
  return items;
};

// ── Generic JSON API fetcher ──────────────────────────────────────────────────

/**
 * Fetch from any JSON REST endpoint.
 * cfg: {
 *   url, headers: {}, method: 'GET',
 *   items_path: 'data.products',   // dot-path to array of items
 *   field_map: {                   // map source fields → catalog fields
 *     name: 'title', cost_price: 'price', image_url: 'image', ...
 *   },
 *   currency: 'KES',
 *   category_id: 1
 * }
 */
const fetchCustomApi = async (source, cfg) => {
  if (!cfg.url) { logger.warn('fetcher/custom_api: url not configured'); return []; }
  try {
    const res = await axios({
      method:  cfg.method || 'GET',
      url:     cfg.url,
      headers: cfg.headers || {},
      timeout: 20000,
    });

    // Navigate dot-path to items array
    let data = res.data;
    if (cfg.items_path) {
      for (const key of cfg.items_path.split('.')) {
        data = data?.[key];
        if (!data) break;
      }
    }
    const rawItems = Array.isArray(data) ? data : [];
    const map = cfg.field_map || {};

    return rawItems.map(p => ({
      source_id:    source.id,
      external_id:  String(p[map.id || 'id'] || ''),
      category_id:  cfg.category_id || null,
      name:         p[map.name || 'name'] || '',
      description:  p[map.description || 'description'] || '',
      image_url:    p[map.image_url || 'image_url'] || '',
      cost_price:   toKES(p[map.cost_price || 'price'] || 0, cfg.currency || 'KES'),
      currency:     'KES',
      supplier_url: p[map.supplier_url || 'url'] || '',
      shipping_info: cfg.shipping_info || '',
      stock_status: p[map.stock_status || 'stock_status'] || 'in_stock',
    }));
  } catch (err) {
    logger.warn('fetcher/custom_api: fetch failed', { url: cfg.url, error: err.message });
    return [];
  }
};

// ── CSV import ────────────────────────────────────────────────────────────────

/**
 * Parse CSV text into product rows.
 * Expected columns: name, description, cost_price, sell_price, image_url,
 *                   supplier_url, shipping_info, category_slug
 * @param {string}  csvText    - Raw CSV string
 * @param {number}  sourceId   - product_sources.id
 * @param {object}  categoryMap - { slug: id }
 * @returns {Array<object>}
 */
const parseCsv = (csvText, sourceId, categoryMap = {}) => {
  const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/\s/g, '_'));
  const items   = [];

  for (const line of lines.slice(1)) {
    // Handle quoted fields
    const cols = line.match(/(".*?"|[^,]+)/g) || [];
    const row  = {};
    headers.forEach((h, i) => { row[h] = (cols[i] || '').replace(/^"|"$/g, '').trim(); });

    if (!row.name) continue;
    items.push({
      source_id:    sourceId,
      external_id:  row.sku || row.id || null,
      category_id:  categoryMap[row.category_slug] || null,
      name:         row.name,
      description:  row.description || '',
      image_url:    row.image_url || '',
      cost_price:   parseFloat(row.cost_price || 0),
      sell_price:   row.sell_price ? parseFloat(row.sell_price) : null,
      currency:     row.currency || 'KES',
      supplier_url: row.supplier_url || '',
      shipping_info: row.shipping_info || '',
      stock_status: row.stock_status || 'in_stock',
    });
  }
  return items;
};

// ── Main sync orchestrator ────────────────────────────────────────────────────

/**
 * Sync a single source.
 * @param {number|object} sourceOrId
 * @returns {Promise<{inserted, updated, errors}>}
 */
const syncSource = async (sourceOrId) => {
  const source = typeof sourceOrId === 'object' ? sourceOrId : await getSource(sourceOrId);
  if (!source) throw new Error('Source not found');

  const cfg = typeof source.config === 'string'
    ? JSON.parse(source.config)
    : (source.config || {});

  let rawItems = [];

  logger.info('fetcher: syncing source', { id: source.id, type: source.type, name: source.name });

  switch (source.type) {
    case 'jumia':       rawItems = await fetchJumia(source, cfg);       break;
    case 'aliexpress':  rawItems = await fetchAliExpress(source, cfg);  break;
    case 'amazon':      rawItems = await fetchAmazon(source, cfg);      break;
    case 'custom_api':  rawItems = await fetchCustomApi(source, cfg);   break;
    case 'manual':
    case 'csv':
      logger.info('fetcher: manual/csv source — no auto-sync needed');
      return { inserted: 0, updated: 0, errors: 0 };
    default:
      logger.warn('fetcher: unknown source type', { type: source.type });
      return { inserted: 0, updated: 0, errors: 0 };
  }

  logger.info('fetcher: fetched raw items', { source: source.name, count: rawItems.length });

  const stats = await catalog.bulkUpsert(rawItems);

  // Update last_sync timestamp
  await query(
    `UPDATE product_sources SET last_sync = NOW() WHERE id = $1`,
    [source.id]
  );

  logger.info('fetcher: sync complete', { source: source.name, ...stats });
  return { ...stats, errors: 0 };
};

/**
 * Sync all active sources.
 * @returns {Promise<object>} Stats map keyed by source name
 */
const syncAll = async () => {
  const sources = await getSources(true);
  const results = {};
  for (const src of sources) {
    try {
      results[src.name] = await syncSource(src);
    } catch (err) {
      logger.error('fetcher: syncAll source failed', { source: src.name, error: err.message });
      results[src.name] = { inserted: 0, updated: 0, errors: 1 };
    }
  }
  return results;
};

module.exports = {
  getSources, getSource, upsertSource,
  parseCsv, syncSource, syncAll,
  fetchJumia, fetchAliExpress, fetchCustomApi,
};
