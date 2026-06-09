'use strict';

/**
 * @module finance/finance
 * @description P&L, VAT report, and expense tracking.
 *
 * P&L = Revenue (paid invoices + marketplace orders) - COGS (product cost) - Expenses
 */

const { query } = require('../../models/db');

const defaultRange = () => {
  const to = new Date();
  const from = new Date(); from.setDate(1); // start of current month
  return { from: from.toISOString(), to: to.toISOString() };
};

// ── Revenue ───────────────────────────────────────────────────────────────────

const getRevenue = async ({ from, to } = {}) => {
  const r = { from: from || defaultRange().from, to: to || defaultRange().to };

  const [inv, mkt] = await Promise.all([
    // Paid invoices (service revenue)
    query(
      `SELECT COALESCE(SUM(amount_paid),0) AS total, COUNT(*) AS count
       FROM invoices WHERE payment_status != 'draft' AND created_at >= $1 AND created_at <= $2`,
      [r.from, r.to]
    ),
    // Paid marketplace orders (product revenue)
    query(
      `SELECT COALESCE(SUM(amount_paid),0) AS total, COUNT(*) AS count
       FROM marketplace_orders WHERE payment_status='paid' AND created_at >= $1 AND created_at <= $2`,
      [r.from, r.to]
    ),
  ]);

  return {
    service_revenue:  parseFloat(inv.rows[0].total || 0),
    service_invoices: parseInt(inv.rows[0].count || 0),
    product_revenue:  parseFloat(mkt.rows[0].total || 0),
    product_orders:   parseInt(mkt.rows[0].count || 0),
    total:            parseFloat(inv.rows[0].total || 0) + parseFloat(mkt.rows[0].total || 0),
  };
};

// ── COGS ─────────────────────────────────────────────────────────────────────

const getCOGS = async ({ from, to } = {}) => {
  const r = { from: from || defaultRange().from, to: to || defaultRange().to };
  const res = await query(
    `SELECT COALESCE(SUM(oi.cost_price * oi.qty), 0) AS cogs
     FROM marketplace_order_items oi
     JOIN marketplace_orders o ON oi.order_id = o.id
     WHERE o.payment_status = 'paid' AND o.created_at >= $1 AND o.created_at <= $2`,
    [r.from, r.to]
  );
  return parseFloat(res.rows[0].cogs || 0);
};

// ── Expenses ─────────────────────────────────────────────────────────────────

const getExpenses = async ({ from, to, category } = {}) => {
  const r = { from: from || defaultRange().from, to: to || defaultRange().to };
  const conds = ['expense_date >= $1', 'expense_date <= $2'];
  const params = [r.from.split('T')[0], r.to.split('T')[0]];
  if (category) { params.push(category); conds.push('category = $' + params.length); }

  const res = await query(
    `SELECT * FROM expenses WHERE ${conds.join(' AND ')} ORDER BY expense_date DESC`,
    params
  );
  const total = res.rows.reduce(function(s, e) { return s + parseFloat(e.amount); }, 0);
  return { expenses: res.rows, total };
};

const addExpense = async ({ category, description, amount, currency, receiptRef, expenseDate }) => {
  const res = await query(
    `INSERT INTO expenses (category,description,amount,currency,receipt_ref,expense_date)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [category, description||null, amount, currency||'KES', receiptRef||null, expenseDate||new Date().toISOString().split('T')[0]]
  );
  return res.rows[0];
};

const getExpenseCategories = async () => {
  const res = await query(
    `SELECT category, SUM(amount) AS total, COUNT(*) AS count
     FROM expenses GROUP BY category ORDER BY total DESC`
  );
  return res.rows;
};

// ── P&L ───────────────────────────────────────────────────────────────────────

/**
 * Full Profit & Loss statement.
 */
const getProfitAndLoss = async (opts = {}) => {
  const [revenue, cogs, expenseData] = await Promise.all([
    getRevenue(opts),
    getCOGS(opts),
    getExpenses(opts),
  ]);

  const grossProfit  = revenue.total - cogs;
  const netProfit    = grossProfit - expenseData.total;
  const grossMargin  = revenue.total > 0 ? (grossProfit / revenue.total * 100) : 0;
  const netMargin    = revenue.total > 0 ? (netProfit   / revenue.total * 100) : 0;

  return {
    revenue,
    cogs,
    gross_profit:  grossProfit,
    expenses:      expenseData.total,
    expense_detail: expenseData.expenses,
    net_profit:    netProfit,
    gross_margin:  Math.round(grossMargin * 100) / 100,
    net_margin:    Math.round(netMargin   * 100) / 100,
  };
};

// ── VAT Report ────────────────────────────────────────────────────────────────

/**
 * Monthly VAT summary — output tax (on sales) and net VAT payable.
 */
const getVatReport = async (opts = {}) => {
  const r = { from: opts.from || defaultRange().from, to: opts.to || defaultRange().to };

  const [invVat, mktVat] = await Promise.all([
    query(
      `SELECT COALESCE(SUM(tax_amount),0) AS vat, COALESCE(SUM(total),0) AS gross
       FROM invoices WHERE created_at >= $1 AND created_at <= $2 AND status != 'cancelled'`,
      [r.from, r.to]
    ),
    query(
      `SELECT COALESCE(SUM(total * 0.16 / 1.16), 0) AS vat, COALESCE(SUM(total),0) AS gross
       FROM marketplace_orders WHERE payment_status='paid' AND created_at >= $1 AND created_at <= $2`,
      [r.from, r.to]
    ),
  ]);

  const totalVat   = parseFloat(invVat.rows[0].vat) + parseFloat(mktVat.rows[0].vat);
  const totalGross = parseFloat(invVat.rows[0].gross) + parseFloat(mktVat.rows[0].gross);

  return {
    invoice_vat:   parseFloat(invVat.rows[0].vat),
    invoice_gross: parseFloat(invVat.rows[0].gross),
    product_vat:   parseFloat(mktVat.rows[0].vat),
    product_gross: parseFloat(mktVat.rows[0].gross),
    total_vat:     Math.round(totalVat * 100) / 100,
    total_gross:   Math.round(totalGross * 100) / 100,
    period:        { from: r.from, to: r.to },
  };
};

module.exports = {
  getRevenue, getCOGS,
  getExpenses, addExpense, getExpenseCategories,
  getProfitAndLoss, getVatReport,
};
