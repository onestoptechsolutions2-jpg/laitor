'use strict';

/**
 * @module marketplace/checkout
 * @description Checkout orchestration — turns a cart into a confirmed order.
 *
 * Steps:
 *   1. Validate cart has items
 *   2. Collect delivery address (WhatsApp message)
 *   3. Select payment method
 *   4. Create marketplace_order + snapshot items
 *   5a. M-Pesa → initiate STK push, save checkoutRequestId, wait for callback
 *   5b. COD / Bank → mark pending, notify admin
 *   6. Send confirmation WhatsApp message
 */

const { query }  = require('../../models/db');
const cart       = require('./cart');
const payment    = require('./payment');
const logger     = require('../../utils/logger');

// ── Order number ──────────────────────────────────────────────────────────────

const nextOrderNumber = async () => {
  const yr  = new Date().getFullYear();
  const res = await query(
    `SELECT COUNT(*) FROM marketplace_orders WHERE EXTRACT(YEAR FROM created_at) = $1`,
    [yr]
  );
  const n   = parseInt(res.rows[0].count) + 1;
  return `LAI-ORD-${yr}-${String(n).padStart(4, '0')}`;
};

// ── Create order from cart ────────────────────────────────────────────────────

/**
 * Create a marketplace order from the customer's active cart.
 * Snapshots all item prices + supplier URLs at checkout time.
 *
 * @param {object} params
 * @param {number} params.customerId
 * @param {string} params.deliveryAddress
 * @param {string} params.paymentMethod  - 'mpesa' | 'cod' | 'bank' | 'credit'
 * @param {string} [params.notes]
 * @param {number} [params.deliveryFee=0]
 * @returns {Promise<object>} Created order
 */
const createOrder = async ({ customerId, deliveryAddress, paymentMethod, notes, deliveryFee = 0 }) => {
  const summary = await cart.getCartSummary(customerId);
  if (!summary.items.length) throw new Error('Cart is empty');

  const orderNumber = await nextOrderNumber();
  const subtotal    = summary.subtotal;
  const total       = Math.round((subtotal + deliveryFee) * 100) / 100;

  // Create order header
  const orderRes = await query(
    `INSERT INTO marketplace_orders
       (order_number, customer_id, cart_id, delivery_address, payment_method,
        subtotal, delivery_fee, total, currency, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'KES',$9)
     RETURNING *`,
    [
      orderNumber, customerId, summary.cart.id,
      deliveryAddress, paymentMethod,
      subtotal, deliveryFee, total, notes || null,
    ]
  );
  const order = orderRes.rows[0];

  // Snapshot order items (with cost_price for margin reporting)
  for (const item of summary.items) {
    await query(
      `INSERT INTO marketplace_order_items
         (order_id, product_id, product_name, qty, unit_price, cost_price, total, supplier_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        order.id, item.product_id, item.name,
        item.qty, item.unit_price,
        item.cost_price || 0,
        parseFloat(item.unit_price) * item.qty,
        item.supplier_url || null,
      ]
    );
  }

  // Mark cart as checked out
  await cart.checkoutCart(summary.cart.id, customerId);

  logger.info('checkout: order created', { orderId: order.id, orderNumber, customerId, total, paymentMethod });  supabaseSync.syncOrder(order, summary.items.map(i => ({
    product_name: i.name,
    qty:          i.qty,
    unit_price:   i.unit_price,
    cost_price:   i.cost_price || 0,
    supplier_url: i.supplier_url || null,
  }))).catch(() => {});

  return order;
};

// ── Payment initiation ────────────────────────────────────────────────────────

/**
 * Initiate M-Pesa STK push for an order.
 * Saves checkoutRequestId to order row.
 * @param {object} order  - marketplace_order row
 * @param {string} phone  - Customer phone (254XXXXXXXXX)
 * @returns {Promise<{success: boolean, message: string, checkoutRequestId?: string}>}
 */
const initiateMpesa = async (order, phone) => {
  const result = await payment.initiateStkPush({
    phone,
    amount:     order.total,
    orderId:    order.id,
    accountRef: order.order_number,
  });

  if (result.success) {
    await query(
      `UPDATE marketplace_orders SET mpesa_checkout_id = $1, updated_at = NOW() WHERE id = $2`,
      [result.checkoutRequestId, order.id]
    );
  }
  return result;
};

/**
 * Manually confirm a payment (COD collected, bank receipt verified, etc.)
 * @param {number} orderId
 * @param {number} amount
 * @param {string} [reference]
 * @returns {Promise<object>}
 */
const confirmManualPayment = async (orderId, amount, reference) => {
  const res = await query(
    `UPDATE marketplace_orders
     SET payment_status = 'paid', amount_paid = $1, mpesa_receipt = $2,
         status = 'confirmed', updated_at = NOW()
     WHERE id = $3 RETURNING *`,
    [amount, reference || 'MANUAL', orderId]
  );
  return res.rows[0];
};

/**
 * Mark order as dispatched.
 * @param {number} orderId
 * @param {string} [trackingInfo]
 */
const markDispatched = async (orderId, trackingInfo) => {
  const res = await query(
    `UPDATE marketplace_orders
     SET status = 'shipped', dispatched_at = NOW(),
         notes = COALESCE(notes, '') || $1, updated_at = NOW()
     WHERE id = $2 RETURNING *`,
    [trackingInfo ? '\nTracking: ' + trackingInfo : '', orderId]
  );
  return res.rows[0];
};

/**
 * Mark order as delivered.
 * @param {number} orderId
 */
const markDelivered = async (orderId) => {
  const res = await query(
    `UPDATE marketplace_orders
     SET status = 'delivered', delivered_at = NOW(), updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [orderId]
  );
  return res.rows[0];
};

// ── Get order ─────────────────────────────────────────────────────────────────

/**
 * Get order with items + customer.
 * @param {number} orderId
 */
const getOrder = async (orderId) => {
  const orderRes = await query(
    `SELECT o.*, c.phone, c.name AS customer_name
     FROM marketplace_orders o
     JOIN customers c ON o.customer_id = c.id
     WHERE o.id = $1`,
    [orderId]
  );
  if (!orderRes.rows[0]) return null;
  const order = orderRes.rows[0];

  const itemRes = await query(
    `SELECT * FROM marketplace_order_items WHERE order_id = $1 ORDER BY id`,
    [orderId]
  );
  order.items = itemRes.rows;
  return order;
};

/**
 * List orders with optional filters.
 * @param {object} opts
 */
const listOrders = async ({ status, customerId, limit = 50, offset = 0 } = {}) => {
  const conds = [], params = [];
  if (status) {
    params.push(status);
    conds.push(`o.status = $${params.length}`);
  }
  if (customerId) {
    params.push(customerId);
    conds.push(`o.customer_id = $${params.length}`);
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  params.push(limit, offset);
  const res = await query(
    `SELECT o.*, c.phone, c.name AS customer_name
     FROM marketplace_orders o
     JOIN customers c ON o.customer_id = c.id
     ${where}
     ORDER BY o.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return res.rows;
};

// ── WhatsApp message builders ─────────────────────────────────────────────────

const buildOrderConfirmation = (order) => {
  const lines = [
    '✅ *Order Confirmed!*',
    '',
    `🧾 Order: *${order.order_number}*`,
    `💰 Total: *KES ${parseFloat(order.total).toLocaleString('en-KE', { minimumFractionDigits: 2 })}*`,
    `📦 Payment: ${order.payment_method.toUpperCase()}`,
    '',
    '📍 Delivery to:',
    order.delivery_address,
    '',
    'We\'ll send you updates as your order is processed.',
    'Thank you for shopping with Laitor! 🎉',
  ];
  return lines.join('\n');
};

const buildPaymentInstructions = (order) => {
  const amt = parseFloat(order.total).toLocaleString('en-KE', { minimumFractionDigits: 2 });
  const shortcode = process.env.MPESA_SHORTCODE || 'XXXXXX';
  return [
    `💳 *Pay via M-Pesa*`,
    '',
    `Amount: *KES ${amt}*`,
    `Paybill: *${shortcode}*`,
    `Account: *${order.order_number}*`,
    '',
    'Or reply *PAY* to receive an M-Pesa prompt on your phone.',
  ].join('\n');
};

module.exports = {
  createOrder, initiateMpesa, confirmManualPayment,
  markDispatched, markDelivered,
  getOrder, listOrders,
  buildOrderConfirmation, buildPaymentInstructions,
  nextOrderNumber,
};
