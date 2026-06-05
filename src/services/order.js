'use strict';

const { query } = require('../models/db');
const logger = require('../utils/logger');

/**
 * Order statuses — single source of truth.
 */
const ORDER_STATUS = {
  PENDING:    'pending',
  CONFIRMED:  'confirmed',
  PROCESSING: 'processing',
  FULFILLED:  'fulfilled',
  CANCELLED:  'cancelled',
};

/**
 * Create a new order record.
 *
 * @param {{ customerId: number, product: string, notes: string }} params
 * @returns {Promise<object>} Created order row
 */
const create = async ({ customerId, product, notes }) => {
  const res = await query(
    `INSERT INTO orders (customer_id, product, status, notes)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [customerId, product || 'Unknown product', ORDER_STATUS.PENDING, notes || null]
  );
  const order = res.rows[0];
  logger.info('Order created', { orderId: order.id, customerId, product });
  return order;
};

/**
 * Update order status.
 *
 * @param {number} orderId
 * @param {string} status  — one of ORDER_STATUS values
 * @returns {Promise<object|null>}
 */
const updateStatus = async (orderId, status) => {
  const res = await query(
    `UPDATE orders SET status = $1, updated_at = NOW()
     WHERE id = $2 RETURNING *`,
    [status, orderId]
  );
  if (!res.rows.length) {
    logger.warn('Order not found for status update', { orderId });
    return null;
  }
  logger.info('Order status updated', { orderId, status });
  return res.rows[0];
};

/**
 * Fetch order by ID.
 *
 * @param {number} orderId
 * @returns {Promise<object|null>}
 */
const getById = async (orderId) => {
  const res = await query(
    `SELECT o.*, c.phone, c.name
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     WHERE o.id = $1`,
    [orderId]
  );
  return res.rows[0] || null;
};

/**
 * Fetch all open orders for admin dashboard view.
 *
 * @returns {Promise<object[]>}
 */
const getOpen = async () => {
  const res = await query(
    `SELECT o.*, c.phone, c.name
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     WHERE o.status NOT IN ('fulfilled', 'cancelled')
     ORDER BY o.created_at DESC
     LIMIT 50`
  );
  return res.rows;
};

module.exports = { create, updateStatus, getById, getOpen, ORDER_STATUS };
