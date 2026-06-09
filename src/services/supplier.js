'use strict';
const { query } = require('../models/db');

async function list({ active, page=1, limit=50 } = {}) {
  const params=[], conds=[];
  if (active !== undefined) { params.push(active); conds.push(`active=$${params.length}`); }
  const where  = conds.length ? 'WHERE '+conds.join(' AND ') : '';
  const offset = (page-1)*limit;
  params.push(limit, offset);
  const { rows } = await query(
    `SELECT * FROM suppliers ${where} ORDER BY name LIMIT $${params.length-1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

async function upsert({ id, name, contactName, phone, email, location, category, paymentTerms, leadTimeDays, notes }) {
  if (id) {
    const { rows } = await query(
      `UPDATE suppliers SET name=$1,contact_name=$2,phone=$3,email=$4,location=$5,category=$6,
       payment_terms=$7,lead_time_days=$8,notes=$9 WHERE id=$10 RETURNING *`,
      [name, contactName||null, phone||null, email||null, location||null, category||null,
       paymentTerms||null, leadTimeDays||3, notes||null, id]
    );
    return rows[0];
  }
  const { rows } = await query(
    `INSERT INTO suppliers (name,contact_name,phone,email,location,category,payment_terms,lead_time_days,notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [name, contactName||null, phone||null, email||null, location||null, category||null,
     paymentTerms||null, leadTimeDays||3, notes||null]
  );
  return rows[0];
}

async function remove(id) {
  await query('UPDATE suppliers SET active=false WHERE id=$1', [id]);
}

module.exports = { list, upsert, remove };
