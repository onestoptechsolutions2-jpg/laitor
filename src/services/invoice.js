'use strict';

/**
 * @module invoice
 * @description Built-in accounting: invoices and payment recording.
 *
 * Invoice lifecycle:
 *   draft → sent → paid (or partial → paid)
 *                → overdue
 *                → cancelled
 *
 * Invoice numbers: LAI-YYYY-NNNN (e.g. LAI-2026-0042)
 *
 * Kenya VAT: 16% applied by default (configurable per invoice).
 */

const { query } = require('../models/db');
const logger    = require('../utils/logger');

// ── Invoice number ────────────────────────────────────────────────────────────

const nextInvoiceNumber = async () => {
  const year = new Date().getFullYear();
  const r = await query(
    `SELECT COUNT(*) FROM invoices WHERE invoice_number LIKE $1`,
    [`LAI-${year}-%`]
  );
  const seq = parseInt(r.rows[0].count, 10) + 1;
  return `LAI-${year}-${String(seq).padStart(4, '0')}`;
};

// ── Create invoice ────────────────────────────────────────────────────────────

/**
 * Create a new invoice.
 *
 * @param {object} params
 * @param {number}  params.customerId
 * @param {number}  [params.orderId]
 * @param {number}  [params.quoteId]
 * @param {Array}   params.lineItems    — [{description, qty, unitPrice}]
 * @param {number}  [params.taxRate]    — default 16 (%)
 * @param {string}  [params.notes]
 * @param {string}  [params.dueDate]   — ISO date string, default 30 days
 * @param {string}  [params.currency]  — default 'KES'
 * @returns {Promise<object>} created invoice row
 */
const create = async ({ customerId, orderId, quoteId, lineItems = [], taxRate = 16, notes, dueDate, currency = 'KES' }) => {
  const subtotal = lineItems.reduce((s, i) => s + (parseFloat(i.unitPrice) || 0) * (parseInt(i.qty) || 1), 0);
  const taxAmount = parseFloat(((subtotal * taxRate) / 100).toFixed(2));
  const total     = parseFloat((subtotal + taxAmount).toFixed(2));

  const due = dueDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const invoiceNumber = await nextInvoiceNumber();

  const r = await query(
    `INSERT INTO invoices
       (invoice_number, customer_id, order_id, quote_id, status,
        line_items, subtotal, tax_rate, tax_amount, total, amount_paid,
        currency, due_date, notes, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,0,$10,$11,$12,NOW(),NOW())
     RETURNING *`,
    [invoiceNumber, customerId, orderId || null, quoteId || null,
     JSON.stringify(lineItems), subtotal, taxRate, taxAmount, total,
     currency, due, notes || null]
  );

  logger.info('Invoice created', { invoiceNumber, customerId, total });
  return r.rows[0];
};

// ── Update status ─────────────────────────────────────────────────────────────

const markSent = async (id) => {
  const r = await query(
    `UPDATE invoices SET status='sent', sent_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING *`,
    [id]
  );
  return r.rows[0];
};

const markCancelled = async (id) => {
  const r = await query(
    `UPDATE invoices SET status='cancelled', updated_at=NOW() WHERE id=$1 RETURNING *`,
    [id]
  );
  return r.rows[0];
};

// ── Record payment ────────────────────────────────────────────────────────────

/**
 * Record a payment against an invoice.
 * Automatically updates invoice status to 'partial' or 'paid'.
 *
 * @param {object} params
 * @param {number}  params.invoiceId
 * @param {number}  params.amount
 * @param {string}  [params.method]     — mpesa | cash | bank | card
 * @param {string}  [params.reference]  — M-Pesa code, bank ref, etc.
 * @param {string}  [params.notes]
 * @returns {Promise<{payment, invoice}>}
 */
const recordPayment = async ({ invoiceId, amount, method = 'mpesa', reference, notes }) => {
  // Insert payment
  const pr = await query(
    `INSERT INTO payments (invoice_id, amount, method, reference, notes, recorded_at, created_at)
     VALUES ($1,$2,$3,$4,$5,NOW(),NOW()) RETURNING *`,
    [invoiceId, amount, method, reference || null, notes || null]
  );
  const payment = pr.rows[0];

  // Sum all payments for this invoice
  const sumR = await query(
    `SELECT COALESCE(SUM(amount),0) AS paid FROM payments WHERE invoice_id = $1`,
    [invoiceId]
  );
  const amountPaid = parseFloat(sumR.rows[0].paid);

  // Fetch invoice total
  const invR = await query(`SELECT total FROM invoices WHERE id=$1`, [invoiceId]);
  const total = parseFloat(invR.rows[0]?.total || 0);

  const newStatus = amountPaid >= total ? 'paid' : amountPaid > 0 ? 'partial' : 'sent';
  const paidAt    = newStatus === 'paid' ? 'NOW()' : 'NULL';

  const updR = await query(
    `UPDATE invoices
     SET amount_paid=$1, status=$2, paid_at=${paidAt === 'NOW()' ? 'NOW()' : 'paid_at'}, updated_at=NOW()
     WHERE id=$3 RETURNING *`,
    [amountPaid, newStatus, invoiceId]
  );

  // Re-run with explicit paid_at logic
  const finalInv = await query(
    `UPDATE invoices
     SET amount_paid=$1, status=$2,
         paid_at = CASE WHEN $2='paid' THEN NOW() ELSE paid_at END,
         updated_at=NOW()
     WHERE id=$3 RETURNING *`,
    [amountPaid, newStatus, invoiceId]
  );

  logger.info('Payment recorded', { invoiceId, amount, method, newStatus });
  return { payment, invoice: finalInv.rows[0] };
};

// ── Overdue check ─────────────────────────────────────────────────────────────

/**
 * Mark all sent/partial invoices past their due date as overdue.
 * Called by a periodic worker (e.g. daily cron or on dashboard load).
 */
const markOverdue = async () => {
  const r = await query(
    `UPDATE invoices
     SET status='overdue', updated_at=NOW()
     WHERE status IN ('sent','partial') AND due_date < CURRENT_DATE
     RETURNING id, invoice_number`
  );
  if (r.rows.length) logger.info('Invoices marked overdue', { count: r.rows.length });
  return r.rows;
};

// ── Fetch helpers ─────────────────────────────────────────────────────────────

const getById = async (id) => {
  const r = await query(
    `SELECT i.*, c.name AS customer_name, c.phone AS customer_phone, c.location AS customer_location
     FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
     WHERE i.id = $1`,
    [id]
  );
  if (!r.rows[0]) return null;
  const inv = r.rows[0];
  const pr  = await query(`SELECT * FROM payments WHERE invoice_id=$1 ORDER BY recorded_at`, [id]);
  inv.payments = pr.rows;
  return inv;
};

const list = async ({ status, customerId, limit = 50, offset = 0 } = {}) => {
  const conditions = [];
  const params     = [];
  if (status)     { params.push(status);     conditions.push(`i.status=$${params.length}`); }
  if (customerId) { params.push(customerId); conditions.push(`i.customer_id=$${params.length}`); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(limit, offset);
  const r = await query(
    `SELECT i.*, c.name AS customer_name, c.phone AS customer_phone
     FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
     ${where} ORDER BY i.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const tot = await query(
    `SELECT COUNT(*) FROM invoices i ${where}`,
    params.slice(0, -2)
  );
  return { invoices: r.rows, total: parseInt(tot.rows[0].count, 10) };
};

// ── Simple HTML invoice (printable / save-as-PDF) ────────────────────────────

const buildHtml = (inv) => {
  const items = (typeof inv.line_items === 'string' ? JSON.parse(inv.line_items) : inv.line_items) || [];
  const rows  = items.map(i => {
    const qty   = parseInt(i.qty) || 1;
    const price = parseFloat(i.unitPrice || i.unit_price || 0);
    return `<tr>
      <td>${i.description || i.name || ''}</td>
      <td style="text-align:center">${qty}</td>
      <td style="text-align:right">${price.toLocaleString('en-KE', {minimumFractionDigits:2})}</td>
      <td style="text-align:right">${(qty * price).toLocaleString('en-KE', {minimumFractionDigits:2})}</td>
    </tr>`;
  }).join('');

  const fmt = (n) => parseFloat(n || 0).toLocaleString('en-KE', {minimumFractionDigits: 2});
  const balance = parseFloat(inv.total || 0) - parseFloat(inv.amount_paid || 0);

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
  <title>Invoice ${inv.invoice_number}</title>
  <style>
    body{font-family:sans-serif;margin:40px;color:#222;font-size:13px}
    .header{display:flex;justify-content:space-between;margin-bottom:32px}
    .brand{font-size:22px;font-weight:700;color:#1a56db}
    .label{color:#888;font-size:11px;text-transform:uppercase;margin-bottom:2px}
    .val{font-size:14px;font-weight:600}
    table{width:100%;border-collapse:collapse;margin:24px 0}
    th{background:#f5f7ff;padding:8px 12px;text-align:left;font-size:12px;text-transform:uppercase;color:#555}
    td{padding:8px 12px;border-bottom:1px solid #eee}
    .totals{margin-left:auto;width:260px}
    .totals tr td:first-child{color:#666}
    .totals tr td:last-child{text-align:right;font-weight:600}
    .totals .grand td{font-size:16px;border-top:2px solid #222}
    .badge{display:inline-block;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600;text-transform:uppercase}
    .paid{background:#d1fae5;color:#065f46} .overdue{background:#fee2e2;color:#991b1b}
    .sent{background:#dbeafe;color:#1e40af} .partial{background:#fef3c7;color:#92400e}
    .draft{background:#f3f4f6;color:#374151}
    @media print{body{margin:0}.no-print{display:none}}
  </style></head><body>
  <div class="header">
    <div>
      <div class="brand">Laitor Invest Limited</div>
      <div style="color:#666;margin-top:4px">P.O. Box · Nairobi, Kenya<br>support@laitor.co.ke</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:24px;font-weight:700;color:#1a56db">INVOICE</div>
      <div class="val">${inv.invoice_number}</div>
      <span class="badge ${inv.status}">${inv.status.toUpperCase()}</span>
    </div>
  </div>
  <div style="display:flex;gap:48px;margin-bottom:24px">
    <div>
      <div class="label">Bill To</div>
      <div class="val">${inv.customer_name || 'Customer'}</div>
      <div style="color:#666">${inv.customer_phone || ''}</div>
      <div style="color:#666">${inv.customer_location || ''}</div>
    </div>
    <div>
      <div class="label">Invoice Date</div>
      <div>${new Date(inv.created_at).toLocaleDateString('en-KE',{day:'2-digit',month:'long',year:'numeric'})}</div>
    </div>
    <div>
      <div class="label">Due Date</div>
      <div style="color:${inv.status==='overdue'?'#dc2626':'inherit'}">${inv.due_date ? new Date(inv.due_date).toLocaleDateString('en-KE',{day:'2-digit',month:'long',year:'numeric'}) : '—'}</div>
    </div>
  </div>
  <table>
    <thead><tr><th>Description</th><th style="text-align:center">Qty</th><th style="text-align:right">Unit Price (KES)</th><th style="text-align:right">Amount (KES)</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <table class="totals">
    <tr><td>Subtotal</td><td>KES ${fmt(inv.subtotal)}</td></tr>
    <tr><td>VAT (${inv.tax_rate || 16}%)</td><td>KES ${fmt(inv.tax_amount)}</td></tr>
    <tr class="grand"><td>Total</td><td>KES ${fmt(inv.total)}</td></tr>
    ${parseFloat(inv.amount_paid || 0) > 0 ? `<tr><td style="color:#059669">Amount Paid</td><td style="color:#059669">KES ${fmt(inv.amount_paid)}</td></tr>` : ''}
    ${balance > 0 ? `<tr><td style="color:#dc2626">Balance Due</td><td style="color:#dc2626">KES ${fmt(balance)}</td></tr>` : ''}
  </table>
  ${inv.notes ? `<div style="margin-top:24px;padding:12px;background:#f9fafb;border-radius:6px;font-size:12px;color:#555">${inv.notes}</div>` : ''}
  <div style="margin-top:48px;font-size:11px;color:#aaa;text-align:center">
    Thank you for your business · Laitor Invest Limited · support@laitor.co.ke
  </div>
  <div class="no-print" style="margin-top:24px;text-align:center">
    <button onclick="window.print()" style="padding:10px 24px;background:#1a56db;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px">🖨 Print / Save PDF</button>
  </div>
  </body></html>`;
};

module.exports = { create, markSent, markCancelled, recordPayment, markOverdue, getById, list, buildHtml };
