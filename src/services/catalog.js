'use strict';

const axios = require('axios');
const config = require('../config');
const { query } = require('../models/db');
const logger = require('../utils/logger');

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const managerClient = () =>
  axios.create({
    baseURL: `${config.manager.url}/api/${config.manager.businessKey}`,
    headers: {
      Authorization: config.manager.apiKey,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });

/**
 * Fetch items from Manager.io and classify as internet/product.
 * Falls back to DB cache if Manager.io is unreachable.
 */
const fetchFromManager = async () => {
  if (!config.manager.url || !config.manager.businessKey) {
    throw new Error('Manager.io not configured');
  }

  // Try inventory-items first, then items
  let items = [];
  for (const endpoint of ['/inventory-items', '/items']) {
    try {
      const res = await managerClient().get(endpoint);
      if (Array.isArray(res.data) && res.data.length > 0) {
        items = res.data;
        break;
      }
    } catch (err) {
      // try next endpoint
    }
  }

  return items;
};

/**
 * Get catalog split into internet packages and products.
 * Uses DB cache; refreshes from Manager.io if stale.
 */
const getCatalog = async () => {
  // Check DB cache freshness
  const cacheRes = await query(
    `SELECT * FROM catalog_cache
     WHERE cached_at > NOW() - INTERVAL '30 minutes'
     ORDER BY type, name`
  );

  if (cacheRes.rows.length > 0) {
    return splitByType(cacheRes.rows);
  }

  // Refresh from Manager.io
  try {
    const items = await fetchFromManager();

    if (items.length > 0) {
      // Clear old cache
      await query('DELETE FROM catalog_cache');

      for (const item of items) {
        const name = item.Name || item.name || item.ItemCode || String(item.key);
        const desc = item.Description || item.description || '';
        const price = parseFloat(item.UnitPrice || item.Price || item.price || 0) || 0;
        const type = classifyType(name, desc);
        const key = String(item.key || item.Key || item.id || name);

        await query(
          `INSERT INTO catalog_cache (item_key, name, description, price, type, raw)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (item_key) DO UPDATE
           SET name=$2, description=$3, price=$4, type=$5, raw=$6, cached_at=NOW()`,
          [key, name, desc, price, type, JSON.stringify(item)]
        );
      }

      logger.info('Catalog cache refreshed', { count: items.length });
      const fresh = await query('SELECT * FROM catalog_cache ORDER BY type, name');
      return splitByType(fresh.rows);
    }
  } catch (err) {
    logger.error('Catalog fetch from Manager.io failed', { error: err.message });
  }

  // Return stale cache if available
  const stale = await query('SELECT * FROM catalog_cache ORDER BY type, name');
  return splitByType(stale.rows);
};

/**
 * Classify an item as 'internet' or 'product' based on name keywords.
 */
const classifyType = (name, desc) => {
  const text = (name + ' ' + desc).toLowerCase();
  if (/internet|wifi|wi-fi|mbps|fibre|fiber|broadband|package|plan|data|isp/.test(text)) {
    return 'internet';
  }
  return 'product';
};

const splitByType = (rows) => ({
  internet: rows.filter((r) => r.type === 'internet'),
  products: rows.filter((r) => r.type === 'product'),
  all: rows,
});

/**
 * Get a single catalog item by its 1-based index in a list.
 */
const getByIndex = (list, index) => list[index - 1] || null;

module.exports = { getCatalog, getByIndex, classifyType, splitByType };
