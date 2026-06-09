'use strict';
const { query } = require('../models/db');

async function list({ status, page=1, limit=30 } = {}) {
  const params=[], conds=[];
  if (status) { params.push(status); conds.push(`dj.status=$${params.length}`); }
  const where  = conds.length ? 'WHERE '+conds.join(' AND ') : '';
  const offset = (page-1)*limit;
  params.push(limit, offset);
  const { rows } = await query(`
    SELECT dj.*, c.name AS customer_name, c.phone AS customer_phone,
           o.order_number
    FROM delivery_jobs dj
    LEFT JOIN customers c ON c.id = dj.customer_id
    LEFT JOIN marketplace_orders o ON o.id = dj.order_id
    ${where}
    ORDER BY dj.created_at DESC
    LIMIT $${params.length-1} OFFSET $${params.length}
  `, params);
  return rows;
}

async function create({ orderId, customerId, riderName, riderPhone, pickupAddress, deliveryAddress, estimatedAt, notes }) {
  const { rows } = await query(
    `INSERT INTO delivery_jobs (order_id,customer_id,rider_name,rider_phone,pickup_address,delivery_address,estimated_at,notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [orderId||null, customerId||null, riderName||null, riderPhone||null,
     pickupAddress||null, deliveryAddress, estimatedAt||null, notes||null]
  );
  return rows[0];
}

async function updateStatus(id, status, { notes, location } = {}) {
  const { rows } = await query(
    `UPDATE delivery_jobs SET status=$1${status==='delivered'?',delivered_at=NOW()':''} WHERE id=$2 RETURNING *`,
    [status, id]
  );
  await query(
    `INSERT INTO delivery_events (job_id, status, notes, location) VALUES ($1,$2,$3,$4)`,
    [id, status, notes||null, location||null]
  );
  return rows[0];
}

async function events(jobId) {
  const { rows } = await query(
    `SELECT * FROM delivery_events WHERE job_id=$1 ORDER BY created_at`, [jobId]
  );
  return rows;
}

module.exports = { list, create, updateStatus, events };
