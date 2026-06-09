'use strict';

const { query } = require('../models/db');
const manager   = require('./manager');
const logger    = require('../utils/logger');

const CACHE_TTL_MINUTES = 30;

/**
 * Classify item type from name/description keywords.
 */
const classifyType = (name, desc) => {
  const text = ((name || '') + ' ' + (desc || '')).toLowerCase();
  if (/wifi|internet|mbps|fibre|fiber|broadband|package|plan|connectivity/.test(text)) {
    return 'internet';
  }
  return 'product';
};

/**
 * Split a flat array of DB rows into { internet, products, all }.
 */
const splitByType = (rows) => ({
  internet: rows.filter((r) => r.type === 'internet'),
  products: rows.filter((r) => r.type === 'product'),
  all:      rows,
});

/**
 * Get catalog from DB cache (30-min TTL).
 * Falls back to Manager.io if cache is stale or empty.
 */
const getCatalog = async () => {
  try {
    // Check for fresh cache
    const cacheRes = await query(
      `SELECT * FROM catalog_cache
       WHERE cached_at > NOW() - INTERVAL '${CACHE_TTL_MINUTES} minutes'
       ORDER BY type, name`
    );

    if (cacheRes.rows.length > 0) {
      logger.debug('Catalog served from cache', { count: cacheRes.rows.length });
      return cacheRes.rows;
    }

    // Try to fetch from Manager.io
    const items = await manager.getInventoryItems();

    if (items.length > 0) {
      // Upsert into catalog_cache
      for (const item of items) {
        // Manager.io list API uses camelCase: itemName, averageCost
        const name  = item.itemName || item.ItemName || item.Name || item.name || '';
        const desc  = item.description || item.Description || '';
        const price = parseFloat(
          item.averageCost ?? item.SalesPrice ?? item.Price ?? item.price ?? 0
        ) || 0;
        const type  = classifyType(name, desc);
        const key   = (item.key || item.ItemCode || name).toString().toLowerCase().replace(/\s+/g, '-').substring(0, 100);

        await query(
          `INSERT INTO catalog_cache (item_key, name, description, price, type, raw, cached_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (item_key) DO UPDATE SET
             name = EXCLUDED.name, description = EXCLUDED.description,
             price = EXCLUDED.price, type = EXCLUDED.type,
             raw = EXCLUDED.raw, cached_at = NOW()`,
          [key, name, desc, price, type, JSON.stringify(item)]
        ).catch(() => {});
      }

      const fresh = await query(`SELECT * FROM catalog_cache ORDER BY type, name`);
      logger.info('Catalog refreshed from Manager.io', { count: fresh.rows.length });
      return fresh.rows;
    }

    // No Manager.io data — return whatever is in the DB (stale or manual entries)
    const stale = await query(`SELECT * FROM catalog_cache ORDER BY type, name`);
    if (stale.rows.length > 0) {
      logger.debug('Catalog served from stale/manual cache', { count: stale.rows.length });
      return stale.rows;
    }

    logger.warn('Catalog empty — add items via admin dashboard or configure Manager.io');
    return [];
  } catch (err) {
    logger.error('getCatalog failed', { error: err.message });
    return [];
  }
};

/**
 * Get item by 1-based index from a list.
 */
const getByIndex = (list, index) => list[index - 1] || null;

module.exports = { getCatalog, getByIndex, classifyType, splitByType };
