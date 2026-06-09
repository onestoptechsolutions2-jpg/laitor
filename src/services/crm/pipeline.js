'use strict';

/**
 * @module crm/pipeline
 * @description Sales pipeline / deal management.
 * Stages: New Lead → Contacted → Qualified → Proposal → Negotiation → Won/Lost
 */

const { query } = require('../../models/db');
const logger    = require('../../utils/logger');

const getStages = async () => {
  const res = await query(
    `SELECT * FROM pipeline_stages WHERE active = true ORDER BY display_order`
  );
  return res.rows;
};

const upsertStage = async ({ id, name, slug, display_order, color, is_won, is_lost }) => {
  if (id) {
    const res = await query(
      `UPDATE pipeline_stages SET name=$1,color=$2,display_order=$3,is_won=$4,is_lost=$5 WHERE id=$6 RETURNING *`,
      [name, color||'#6366f1', display_order||0, is_won||false, is_lost||false, id]
    );
    return res.rows[0];
  }
  const res = await query(
    `INSERT INTO pipeline_stages (name,slug,display_order,color,is_won,is_lost)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(slug) DO UPDATE SET name=$1,color=$4 RETURNING *`,
    [name, slug||name.toLowerCase().replace(/\s+/g,'-'), display_order||0, color||'#6366f1', is_won||false, is_lost||false]
  );
  return res.rows[0];
};

const logActivity = async ({ customerId, dealId, type, body, createdBy }) => {
  await query(
    `INSERT INTO activities (customer_id,deal_id,type,body,created_by) VALUES ($1,$2,$3,$4,$5)`,
    [customerId||null, dealId||null, type||'note', body||'', createdBy||'system']
  );
};

const createDeal = async ({ title, customerId, stageId, assignedTo, value, currency, source, priority, expectedClose, notes }) => {
  let sId = stageId;
  if (!sId) {
    const s = await query(`SELECT id FROM pipeline_stages ORDER BY display_order LIMIT 1`);
    sId = s.rows[0] && s.rows[0].id;
  }
  const res = await query(
    `INSERT INTO deals (title,customer_id,stage_id,assigned_to,value,currency,source,priority,expected_close,notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [title, customerId||null, sId, assignedTo||null, value||0, currency||'KES', source||'whatsapp', priority||'medium', expectedClose||null, notes||null]
  );
  const deal = res.rows[0];
  await logActivity({ customerId, dealId: deal.id, type: 'note', body: 'Deal created: ' + title, createdBy: 'system' });
  logger.info('pipeline: deal created', { id: deal.id, title });
  return deal;
};

const moveDeal = async (dealId, stageId, agentName) => {
  const stageRes = await query(`SELECT * FROM pipeline_stages WHERE id = $1`, [stageId]);
  const s = stageRes.rows[0];
  if (!s) throw new Error('Stage not found');

  const wonAt  = s.is_won  ? 'NOW()' : 'won_at';
  const lostAt = s.is_lost ? 'NOW()' : 'lost_at';

  const res = await query(
    `UPDATE deals SET stage_id=$1, won_at=${wonAt}, lost_at=${lostAt}, updated_at=NOW() WHERE id=$2 RETURNING *`,
    [stageId, dealId]
  );
  const deal = res.rows[0];
  if (deal) {
    await logActivity({ dealId, customerId: deal.customer_id, type: 'note', body: 'Moved to stage: ' + s.name, createdBy: agentName||'system' });
  }
  return deal;
};

const updateDeal = async (id, data) => {
  const allowed = ['title','value','priority','notes','expected_close','assigned_to','lost_reason'];
  const fields = [], vals = [];
  for (const key of Object.keys(data)) {
    if (allowed.indexOf(key) !== -1) { vals.push(data[key]); fields.push(key + '=$' + vals.length); }
  }
  if (!fields.length) return getDeal(id);
  vals.push(id);
  const res = await query(
    'UPDATE deals SET ' + fields.join(',') + ', updated_at=NOW() WHERE id=$' + vals.length + ' RETURNING *',
    vals
  );
  return res.rows[0];
};

const getDeal = async (id) => {
  const res = await query(
    `SELECT d.*, c.name AS customer_name, c.phone AS customer_phone,
            ps.name AS stage_name, ps.color AS stage_color
     FROM deals d
     LEFT JOIN customers c ON d.customer_id = c.id
     LEFT JOIN pipeline_stages ps ON d.stage_id = ps.id
     WHERE d.id = $1`, [id]
  );
  if (!res.rows[0]) return null;
  const deal = res.rows[0];
  const acts = await query(
    `SELECT * FROM activities WHERE deal_id=$1 ORDER BY created_at DESC LIMIT 20`, [id]
  );
  deal.activities = acts.rows;
  return deal;
};

const getKanban = async () => {
  const stages = await getStages();
  const dealsRes = await query(
    `SELECT d.*, c.name AS customer_name, c.phone AS customer_phone,
            ps.name AS stage_name, ps.color AS stage_color
     FROM deals d
     LEFT JOIN customers c ON d.customer_id = c.id
     LEFT JOIN pipeline_stages ps ON d.stage_id = ps.id
     ORDER BY d.updated_at DESC`
  );
  const byStage = {};
  stages.forEach(function(s) { byStage[s.id] = { stage: s, deals: [] }; });
  dealsRes.rows.forEach(function(d) {
    if (byStage[d.stage_id]) byStage[d.stage_id].deals.push(d);
  });
  return Object.values(byStage);
};

const getPipelineStats = async () => {
  const res = await query(
    `SELECT
       COUNT(*)                              AS total_deals,
       COALESCE(SUM(value),0)               AS total_value,
       COUNT(*) FILTER (WHERE ps.is_won)    AS won,
       COUNT(*) FILTER (WHERE ps.is_lost)   AS lost,
       COALESCE(SUM(value) FILTER (WHERE ps.is_won), 0) AS won_value
     FROM deals d
     LEFT JOIN pipeline_stages ps ON d.stage_id = ps.id`
  );
  return res.rows[0];
};

const getActivities = async (customerId, limit) => {
  const res = await query(
    `SELECT a.*, d.title AS deal_title FROM activities a
     LEFT JOIN deals d ON a.deal_id = d.id
     WHERE a.customer_id = $1 ORDER BY a.created_at DESC LIMIT $2`,
    [customerId, limit || 30]
  );
  return res.rows;
};

const listDeals = async ({ stageId, assignedTo, limit, offset } = {}) => {
  const conds = [], params = [];
  if (stageId)    { params.push(stageId);    conds.push('d.stage_id=$' + params.length); }
  if (assignedTo) { params.push(assignedTo); conds.push('d.assigned_to=$' + params.length); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  params.push(limit||50, offset||0);
  const res = await query(
    `SELECT d.*, c.name AS customer_name, c.phone AS customer_phone,
            ps.name AS stage_name, ps.color AS stage_color
     FROM deals d
     LEFT JOIN customers c ON d.customer_id = c.id
     LEFT JOIN pipeline_stages ps ON d.stage_id = ps.id
     ${where} ORDER BY d.updated_at DESC
     LIMIT $${params.length-1} OFFSET $${params.length}`,
    params
  );
  return res.rows;
};

module.exports = {
  getStages, upsertStage,
  createDeal, moveDeal, updateDeal, getDeal, listDeals, getKanban, getPipelineStats,
  logActivity, getActivities,
};
