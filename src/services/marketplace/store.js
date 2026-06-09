'use strict';

/**
 * @module marketplace/store
 * @description Store enhancements: product variants, inventory, discount codes, shipping zones.
 */

const { query } = require('../../models/db');
const logger    = require('../../utils/logger');

// ── Product Variants ──────────────────────────────────────────────────────────

const getVariants = async (productId) => {
  const res = await query(
    `SELECT * FROM product_variants WHERE product_id=$1 AND active=true ORDER BY id`,
    [productId]
  );
  return res.rows;
};

const upsertVariant = async ({ id, productId, sku, name, attributes, extraPrice, stockQty }) => {
  if (id) {
    const res = await query(
      `UPDATE product_variants SET name=$1,attributes=$2,extra_price=$3,stock_qty=$4 WHERE id=$5 RETURNING *`,
      [name, JSON.stringify(attributes||{}), extraPrice||0, stockQty||0, id]
    );
    return res.rows[0];
  }
  const autoSku = sku || ('VAR-' + productId + '-' + Date.now());
  const res = await query(
    `INSERT INTO product_variants (product_id,sku,name,attributes,extra_price,stock_qty)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [productId, autoSku, name, JSON.stringify(attributes||{}), extraPrice||0, stockQty||0]
  );
  return res.rows[0];
};

// ── Inventory ─────────────────────────────────────────────────────────────────

/**
 * Decrement stock for an order. Called when order is confirmed.
 * Decrements product stock_qty (and variant if variantId given).
 */
const decrementStock = async (productId, qty, variantId) => {
  if (variantId) {
    await query(
      `UPDATE product_variants SET stock_qty = GREATEST(0, stock_qty - $1) WHERE id = $2`,
      [qty, variantId]
    );
  }
  await query(
    `UPDATE products SET stock_qty = GREATEST(0, stock_qty - $1) WHERE id = $2 AND track_stock = true`,
    [qty, productId]
  );
};

/**
 * Get products with low stock (below low_stock_qty threshold).
 */
const getLowStockProducts = async () => {
  const res = await query(
    `SELECT id, name, stock_qty, low_stock_qty FROM products
     WHERE track_stock = true AND stock_qty <= low_stock_qty AND active = true
     ORDER BY stock_qty ASC`
  );
  return res.rows;
};

// ── Discount Codes ────────────────────────────────────────────────────────────

/**
 * Validate and apply a discount code to an order total.
 * @returns {{ valid, discount, code, reason }}
 */
const applyDiscount = async (code, orderTotal, customerId) => {
  const res = await query(
    `SELECT * FROM discount_codes
     WHERE UPPER(code) = UPPER($1) AND active = true
       AND (expires_at IS NULL OR expires_at > NOW())
       AND (max_uses IS NULL OR used_count < max_uses)`,
    [code]
  );
  const dc = res.rows[0];
  if (!dc) return { valid: false, discount: 0, reason: 'Invalid or expired code' };
  if (parseFloat(dc.min_order_value) > parseFloat(orderTotal)) {
    return { valid: false, discount: 0, reason: 'Minimum order of KES ' + dc.min_order_value + ' required' };
  }

  const discount = dc.type === 'pct'
    ? Math.round(parseFloat(orderTotal) * (parseFloat(dc.value) / 100) * 100) / 100
    : Math.min(parseFloat(dc.value), parseFloat(orderTotal));

  return { valid: true, discount, code: dc.code, codeId: dc.id, description: dc.description };
};

/**
 * Increment discount code usage counter.
 */
const markDiscountUsed = async (codeId) => {
  await query(`UPDATE discount_codes SET used_count = used_count + 1 WHERE id = $1`, [codeId]);
};

const listDiscountCodes = async () => {
  const res = await query(`SELECT * FROM discount_codes ORDER BY created_at DESC`);
  return res.rows;
};

const createDiscountCode = async ({ code, description, type, value, minOrderValue, maxUses, appliesTo, targetId, expiresAt }) => {
  const res = await query(
    `INSERT INTO discount_codes (code,description,type,value,min_order_value,max_uses,applies_to,target_id,expires_at)
     VALUES (UPPER($1),$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [code, description||null, type||'pct', value, minOrderValue||0, maxUses||null, appliesTo||'all', targetId||null, expiresAt||null]
  );
  return res.rows[0];
};

// ── Shipping Zones ────────────────────────────────────────────────────────────

const getShippingZones = async () => {
  const res = await query(`SELECT * FROM shipping_zones WHERE active=true ORDER BY rate`);
  return res.rows;
};

const upsertShippingZone = async ({ id, name, regions, rate, freeAbove, estDays }) => {
  if (id) {
    const res = await query(
      `UPDATE shipping_zones SET name=$1,regions=$2,rate=$3,free_above=$4,est_days=$5 WHERE id=$6 RETURNING *`,
      [name, regions||[], rate||0, freeAbove||null, estDays||'2-3 days', id]
    );
    return res.rows[0];
  }
  const res = await query(
    `INSERT INTO shipping_zones (name,regions,rate,free_above,est_days) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [name, regions||[], rate||0, freeAbove||null, estDays||'2-3 days']
  );
  return res.rows[0];
};

/**
 * Find the cheapest applicable shipping zone for a given address string.
 * Falls back to most expensive (Remote) if no match.
 */
const matchShippingZone = async (deliveryAddress) => {
  const zones = await getShippingZones();
  const addr  = (deliveryAddress||'').toLowerCase();
  for (const zone of zones) {
    const regions = (zone.regions || []).map(function(r) { return r.toLowerCase(); });
    if (regions.some(function(r) { return addr.includes(r); })) return zone;
  }
  return zones[zones.length - 1] || null;
};

module.exports = {
  getVariants, upsertVariant,
  decrementStock, getLowStockProducts,
  applyDiscount, markDiscountUsed, listDiscountCodes, createDiscountCode,
  getShippingZones, upsertShippingZone, matchShippingZone,
};
