'use strict';
const { query } = require('../models/db');

async function list({ agentId, period, status, page=1, limit=50 } = {}) {
  const params=[], conds=[];
  if (agentId) { params.push(agentId);  conds.push(`c.agent_id=$${params.length}`); }
  if (period)  { params.push(period);   conds.push(`c.period=$${params.length}`); }
  if (status)  { params.push(status);   conds.push(`c.status=$${params.length}`); }
  const where  = conds.length ? 'WHERE '+conds.join(' AND ') : '';
  const offset = (page-1)*limit;
  params.push(limit, offset);
  const { rows } = await query(`
    SELECT c.*, a.name AS agent_name
    FROM commissions c LEFT JOIN agents a ON a.id=c.agent_id
    ${where} ORDER BY c.created_at DESC
    LIMIT $${params.length-1} OFFSET $${params.length}
  `, params);
  return rows;
}

async function summary(agentId) {
  const { rows } = await query(`
    SELECT
      COALESCE(SUM(commission) FILTER (WHERE status='pending'),  0) AS pending,
      COALESCE(SUM(commission) FILTER (WHERE status='approved'), 0) AS approved,
      COALESCE(SUM(commission) FILTER (WHERE status='paid'),     0) AS paid_total,
      COALESCE(SUM(commission) FILTER (WHERE period=TO_CHAR(NOW(),'YYYY-MM')), 0) AS this_month
    FROM commissions WHERE agent_id=$1
  `, [agentId]);
  return rows[0];
}

async function create({ agentId, customerId, orderId, invoiceId, description, saleAmount, ratePct }) {
  const commission = parseFloat((saleAmount * ratePct / 100).toFixed(2));
  const period     = new Date().toISOString().slice(0,7);
  const { rows }   = await query(
    `INSERT INTO commissions (agent_id,customer_id,order_id,invoice_id,description,sale_amount,rate_pct,commission,period)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [agentId, customerId||null, orderId||null, invoiceId||null, description||null, saleAmount, ratePct, commission, period]
  );
  return rows[0];
}

async function approve(id) {
  const { rows } = await query(
    `UPDATE commissions SET status='approved' WHERE id=$1 RETURNING *`, [id]
  );
  return rows[0];
}

async function markPaid(ids) {
  const { rows } = await query(
    `UPDATE commissions SET status='paid', paid_at=NOW()
     WHERE id=ANY($1) AND status='approved' RETURNING *`,
    [ids]
  );
  return rows;
}

module.exports = { list, summary, create, approve, markPaid };
