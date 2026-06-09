'use strict';

/**
 * @module marketplace/reports
 * @description Sales analytics and reporting for the WhatsApp marketplace.
 *
 * All queries accept { from, to } date range strings (ISO 8601).
 * Defaults to last 30 days when not specified.
 */

const { query } = require('../../models/db');

const defaultRange = () => {
  const to   = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);
  return { from: from.toISOString(), to: to.toISOString() };
};

const range = (opts = {}) => ({
  from: opts.from || defaultRange().from,
  to:   opts.to   || defaultRange().to,
});

// ── Overview ──────────────────────────────────────────────────────────────────

/**
 * High-level sales KPIs for the dashboard header cards.
 * @param {object} opts - { from, to }
 * @returns {Promise<object>}
 */
const getSalesSummary = async (opts = {}) => {
  const { from, to } = range(opts);
  const res = await query(
    `SELECT
       COUNT(*)                                         AS total_orders,
       COUNT(*) FILTER (WHERE payment_status = 'paid') AS paid_orders,
       COUNT(*) FILTER (WHERE status = 'pending')      AS pending_orders,
       COUNT(*) FILTER (WHERE status = 'delivered')    AS delivered_orders,
       COALESCE(SUM(total), 0)                          AS total_revenue,
       COALESCE(SUM(amount_paid), 0)                    AS total_collected,
       COALESCE(AVG(total), 0)                          AS avg_order_value
     FROM marketplace_orders
     WHERE created_at >= $1 AND created_at <= $2`,
    [from, to]
  );
  return res.rows[0];
};

/**
 * Gross profit margin (revenue - cost).
 * @param {object} opts
 */
const getProfitMargin = async (opts = {}) => {
  const { from, to } = range(opts);
  const res = await query(
    `SELECT
       COALESCE(SUM(i.total), 0)                     AS revenue,
       COALESCE(SUM(i.cost_price * i.qty), 0)        AS total_cost,
       COALESCE(SUM(i.total) - SUM(i.cost_price * i.qty), 0) AS gross_profit,
       CASE WHEN SUM(i.total) > 0
            THEN ROUND(((SUM(i.total) - SUM(i.cost_price * i.qty)) / SUM(i.total)) * 100, 2)
            ELSE 0 END                                AS margin_pct
     FROM marketplace_order_items i
     JOIN marketplace_orders o ON i.order_id = o.id
     WHERE o.created_at >= $1 AND o.created_at <= $2
       AND o.payment_status = 'paid'`,
    [from, to]
  );
  return res.rows[0];
};

// ── Time series ───────────────────────────────────────────────────────────────

/**
 * Daily revenue time series for charts.
 * @param {object} opts - { from, to }
 * @returns {Promise<Array<{date, revenue, orders}>>}
 */
const getDailyRevenue = async (opts = {}) => {
  const { from, to } = range(opts);
  const res = await query(
    `SELECT
       DATE_TRUNC('day', created_at)::DATE     AS date,
       COALESCE(SUM(total), 0)                 AS revenue,
       COALESCE(SUM(amount_paid), 0)           AS collected,
       COUNT(*)                                AS orders
     FROM marketplace_orders
     WHERE created_at >= $1 AND created_at <= $2
     GROUP BY 1
     ORDER BY 1`,
    [from, to]
  );
  return res.rows;
};

/**
 * Monthly revenue summary.
 */
const getMonthlyRevenue = async (opts = {}) => {
  const { from, to } = range(opts);
  const res = await query(
    `SELECT
       TO_CHAR(DATE_TRUNC('month', created_at), 'Mon YYYY') AS month,
       DATE_TRUNC('month', created_at)                       AS month_date,
       COALESCE(SUM(total), 0)                               AS revenue,
       COUNT(*)                                              AS orders
     FROM marketplace_orders
     WHERE created_at >= $1 AND created_at <= $2
     GROUP BY DATE_TRUNC('month', created_at)
     ORDER BY month_date`,
    [from, to]
  );
  return res.rows;
};

// ── Products ──────────────────────────────────────────────────────────────────

/**
 * Top-selling products by units sold.
 * @param {object} opts - { from, to, limit }
 */
const getTopProducts = async (opts = {}) => {
  const { from, to } = range(opts);
  const limit = opts.limit || 10;
  const res = await query(
    `SELECT
       i.product_id,
       i.product_name,
       SUM(i.qty)                 AS units_sold,
       SUM(i.total)               AS revenue,
       SUM(i.cost_price * i.qty)  AS total_cost,
       SUM(i.total) - SUM(i.cost_price * i.qty) AS profit,
       COUNT(DISTINCT i.order_id) AS order_count
     FROM marketplace_order_items i
     JOIN marketplace_orders o ON i.order_id = o.id
     WHERE o.created_at >= $1 AND o.created_at <= $2
     GROUP BY i.product_id, i.product_name
     ORDER BY units_sold DESC
     LIMIT $3`,
    [from, to, limit]
  );
  return res.rows;
};

/**
 * Revenue breakdown by category.
 */
const getRevenueByCategory = async (opts = {}) => {
  const { from, to } = range(opts);
  const res = await query(
    `SELECT
       mc.name                    AS category,
       mc.icon                    AS icon,
       COUNT(DISTINCT o.id)       AS orders,
       SUM(i.qty)                 AS units,
       SUM(i.total)               AS revenue
     FROM marketplace_order_items i
     JOIN marketplace_orders o ON i.order_id = o.id
     JOIN products p             ON i.product_id = p.id
     JOIN marketplace_categories mc ON p.category_id = mc.id
     WHERE o.created_at >= $1 AND o.created_at <= $2
     GROUP BY mc.id, mc.name, mc.icon
     ORDER BY revenue DESC`,
    [from, to]
  );
  return res.rows;
};

// ── Customers ─────────────────────────────────────────────────────────────────

/**
 * Top customers by spend.
 * @param {object} opts - { from, to, limit }
 */
const getTopCustomers = async (opts = {}) => {
  const { from, to } = range(opts);
  const limit = opts.limit || 10;
  const res = await query(
    `SELECT
       c.id, c.name, c.phone,
       COUNT(o.id)          AS order_count,
       SUM(o.total)         AS total_spent,
       SUM(o.amount_paid)   AS total_paid,
       MAX(o.created_at)    AS last_order_at
     FROM marketplace_orders o
     JOIN customers c ON o.customer_id = c.id
     WHERE o.created_at >= $1 AND o.created_at <= $2
     GROUP BY c.id, c.name, c.phone
     ORDER BY total_spent DESC
     LIMIT $3`,
    [from, to, limit]
  );
  return res.rows;
};

// ── Order pipeline ────────────────────────────────────────────────────────────

/**
 * Order status breakdown — for kanban / pipeline view.
 */
const getOrderStatusBreakdown = async () => {
  const res = await query(
    `SELECT
       status,
       payment_status,
       COUNT(*)         AS count,
       SUM(total)       AS total_value
     FROM marketplace_orders
     GROUP BY status, payment_status
     ORDER BY status`
  );
  return res.rows;
};

/**
 * Payment method distribution.
 */
const getPaymentMethodBreakdown = async (opts = {}) => {
  const { from, to } = range(opts);
  const res = await query(
    `SELECT
       payment_method,
       COUNT(*)        AS count,
       SUM(total)      AS total_value,
       SUM(amount_paid) AS collected
     FROM marketplace_orders
     WHERE created_at >= $1 AND created_at <= $2
     GROUP BY payment_method
     ORDER BY count DESC`,
    [from, to]
  );
  return res.rows;
};

// ── Source performance ────────────────────────────────────────────────────────

/**
 * Which product sources are generating the most sales.
 */
const getSourcePerformance = async (opts = {}) => {
  const { from, to } = range(opts);
  const res = await query(
    `SELECT
       ps.name                    AS source_name,
       ps.type                    AS source_type,
       COUNT(DISTINCT p.id)       AS product_count,
       COALESCE(SUM(oi.qty), 0)   AS units_sold,
       COALESCE(SUM(oi.total), 0) AS revenue
     FROM product_sources ps
     LEFT JOIN products p              ON p.source_id = ps.id
     LEFT JOIN marketplace_order_items oi ON oi.product_id = p.id
     LEFT JOIN marketplace_orders o    ON oi.order_id = o.id
       AND o.created_at >= $1 AND o.created_at <= $2
     GROUP BY ps.id, ps.name, ps.type
     ORDER BY revenue DESC`,
    [from, to]
  );
  return res.rows;
};

/**
 * Full report bundle for the dashboard Reports tab.
 * @param {object} opts - { from, to }
 */
const getFullReport = async (opts = {}) => {
  const [summary, profit, daily, categories, topProducts, topCustomers, statusBreakdown, paymentMethods] =
    await Promise.all([
      getSalesSummary(opts),
      getProfitMargin(opts),
      getDailyRevenue(opts),
      getRevenueByCategory(opts),
      getTopProducts({ ...opts, limit: 10 }),
      getTopCustomers({ ...opts, limit: 10 }),
      getOrderStatusBreakdown(),
      getPaymentMethodBreakdown(opts),
    ]);

  return { summary, profit, daily, categories, topProducts, topCustomers, statusBreakdown, paymentMethods };
};

module.exports = {
  getSalesSummary, getProfitMargin,
  getDailyRevenue, getMonthlyRevenue,
  getTopProducts, getRevenueByCategory,
  getTopCustomers, getOrderStatusBreakdown,
  getPaymentMethodBreakdown, getSourcePerformance,
  getFullReport,
};
