'use strict';

/**
 * @module marketplace/cart
 * @description Shopping cart service — Redis (fast) + PostgreSQL (persistent).
 *
 * One active cart per customer. Redis holds the working state for speed;
 * DB is the source of truth. If Redis is unavailable, falls back to DB-only.
 *
 * Cart lifecycle: active → checked_out | abandoned
 */

const { query }   = require('../../models/db');
const session     = require('../session');        // Redis wrapper
const catalog     = require('./catalog');
const logger      = require('../../utils/logger');

const CART_TTL    = 60 * 60 * 24 * 7; // 7 days in Redis
const cartKey     = (customerId) => `cart:${customerId}`;

// ── Redis helpers (non-fatal) ─────────────────────────────────────────────────

const rSet = async (k, v) => {
  try { await session.set(k, JSON.stringify(v), CART_TTL); } catch (_) {}
};
const rGet = async (k) => {
  try {
    const v = await session.get(k);
    return v ? JSON.parse(v) : null;
  } catch (_) { return null; }
};
const rDel = async (k) => {
  try { await session.del(k); } catch (_) {}
};

// ── DB helpers ────────────────────────────────────────────────────────────────

/** Get or create the active cart for a customer. Returns cart DB row. */
const ensureCart = async (customerId) => {
  let res = await query(
    `SELECT * FROM carts WHERE customer_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    [customerId]
  );
  if (res.rows.length) return res.rows[0];
  res = await query(
    `INSERT INTO carts (customer_id) VALUES ($1) RETURNING *`,
    [customerId]
  );
  return res.rows[0];
};

/** Load cart items from DB with product details. */
const loadCartFromDB = async (cartId) => {
  const res = await query(
    `SELECT ci.id, ci.product_id, ci.qty, ci.unit_price,
            p.name, p.image_url, p.currency, p.stock_status
     FROM cart_items ci
     JOIN products p ON ci.product_id = p.id
     WHERE ci.cart_id = $1`,
    [cartId]
  );
  return res.rows;
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get cart summary for a customer.
 * @param {number} customerId
 * @returns {Promise<{cart: object, items: Array, subtotal: number, count: number}>}
 */
const getCartSummary = async (customerId) => {
  const cart  = await ensureCart(customerId);
  const items = await loadCartFromDB(cart.id);

  const subtotal = items.reduce((sum, i) => sum + parseFloat(i.unit_price) * i.qty, 0);
  const count    = items.reduce((sum, i) => sum + i.qty, 0);

  const summary = { cart, items, subtotal: Math.round(subtotal * 100) / 100, count };
  await rSet(cartKey(customerId), summary);
  return summary;
};

/**
 * Add a product to the cart (or increment qty if already present).
 * @param {number} customerId
 * @param {number} productId
 * @param {number} [qty=1]
 * @returns {Promise<object>} Updated summary
 */
const addItem = async (customerId, productId, qty = 1) => {
  const product = await catalog.getProduct(productId);
  if (!product)                          throw new Error('Product not found');
  if (product.stock_status === 'out_of_stock')
                                          throw new Error('Product is out of stock');

  const cart  = await ensureCart(customerId);
  const price = catalog.computePrice(product);

  // Upsert cart item
  const existing = await query(
    `SELECT id, qty FROM cart_items WHERE cart_id = $1 AND product_id = $2`,
    [cart.id, productId]
  );

  if (existing.rows.length) {
    await query(
      `UPDATE cart_items SET qty = qty + $1 WHERE id = $2`,
      [qty, existing.rows[0].id]
    );
  } else {
    await query(
      `INSERT INTO cart_items (cart_id, product_id, qty, unit_price) VALUES ($1, $2, $3, $4)`,
      [cart.id, productId, qty, price]
    );
  }

  await query(`UPDATE carts SET updated_at = NOW() WHERE id = $1`, [cart.id]);
  logger.debug('cart: item added', { customerId, productId, qty, price });
  return getCartSummary(customerId);
};

/**
 * Update quantity of a cart item.
 * @param {number} customerId
 * @param {number} productId
 * @param {number} qty - set to 0 to remove
 * @returns {Promise<object>}
 */
const updateQty = async (customerId, productId, qty) => {
  const cart = await ensureCart(customerId);
  if (qty <= 0) {
    await query(
      `DELETE FROM cart_items WHERE cart_id = $1 AND product_id = $2`,
      [cart.id, productId]
    );
  } else {
    await query(
      `UPDATE cart_items SET qty = $1 WHERE cart_id = $2 AND product_id = $3`,
      [qty, cart.id, productId]
    );
  }
  return getCartSummary(customerId);
};

/**
 * Remove a product from the cart.
 * @param {number} customerId
 * @param {number} productId
 */
const removeItem = async (customerId, productId) =>
  updateQty(customerId, productId, 0);

/**
 * Empty the cart.
 * @param {number} customerId
 */
const clearCart = async (customerId) => {
  const cart = await ensureCart(customerId);
  await query(`DELETE FROM cart_items WHERE cart_id = $1`, [cart.id]);
  await query(`UPDATE carts SET updated_at = NOW() WHERE id = $1`, [cart.id]);
  await rDel(cartKey(customerId));
  return { cart, items: [], subtotal: 0, count: 0 };
};

/**
 * Mark cart as checked out (called when order is created).
 * @param {number} cartId
 */
const checkoutCart = async (cartId, customerId) => {
  await query(
    `UPDATE carts SET status = 'checked_out', updated_at = NOW() WHERE id = $1`,
    [cartId]
  );
  await rDel(cartKey(customerId));
};

/**
 * Build WhatsApp cart summary message text.
 * @param {object} summary - from getCartSummary
 * @returns {string}
 */
const buildCartText = (summary) => {
  if (!summary.items.length) {
    return '🛒 *Your cart is empty.*\n\nReply *SHOP* to browse our products.';
  }
  const lines = ['🛒 *Your Cart*', ''];
  summary.items.forEach((item, i) => {
    const total = (parseFloat(item.unit_price) * item.qty).toLocaleString('en-KE', { minimumFractionDigits: 2 });
    lines.push(`${i + 1}. ${item.name} × ${item.qty} = KES ${total}`);
  });
  lines.push('');
  lines.push('─'.repeat(28));
  lines.push(`*Total: KES ${summary.subtotal.toLocaleString('en-KE', { minimumFractionDigits: 2 })}*`);
  return lines.join('\n');
};

module.exports = {
  getCartSummary, addItem, removeItem, updateQty, clearCart, checkoutCart,
  buildCartText, ensureCart,
};
