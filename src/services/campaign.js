/**
 * campaign.js — Campaign & Broadcast Engine
 * Create campaigns targeting customer segments, then fire WA/SMS broadcasts.
 */
'use strict';
const { query } = require('../models/db');
const whatsapp  = require('./whatsapp');
const logger    = require('../utils/logger');

// ── Campaign CRUD ────────────────────────────────────────────────────────────

async function list({ status, page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;
  const params = [];
  let where = '';
  if (status) { params.push(status); where = `WHERE c.status = $${params.length}`; }
  const { rows } = await query(`
    SELECT c.*, a.name AS created_by_name,
           (SELECT COUNT(*) FROM broadcasts b WHERE b.campaign_id = c.id) AS broadcast_count
    FROM campaigns c
    LEFT JOIN agents a ON a.id = c.created_by
    ${where}
    ORDER BY c.created_at DESC
    LIMIT $${params.push(limit)} OFFSET $${params.push(offset)}
  `, params);
  return rows;
}

async function create({ name, channel = 'whatsapp', messageTemplate, segmentFilter = {}, scheduledAt, createdBy }) {
  const { rows } = await query(
    `INSERT INTO campaigns (name, channel, message_template, segment_filter, scheduled_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [name, channel, messageTemplate, JSON.stringify(segmentFilter), scheduledAt || null, createdBy || null]
  );
  return rows[0];
}

async function update(id, fields) {
  const allowed = ['name','message_template','segment_filter','status','scheduled_at'];
  const sets = [], params = [];
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) {
      params.push(typeof v === 'object' ? JSON.stringify(v) : v);
      sets.push(`${k} = $${params.length}`);
    }
  }
  if (!sets.length) return null;
  params.push(id);
  const { rows } = await query(
    `UPDATE campaigns SET ${sets.join(',')} WHERE id = $${params.length} RETURNING *`, params
  );
  return rows[0];
}

// ── Build recipient list ─────────────────────────────────────────────────────

async function buildRecipients(filter = {}) {
  const { segments = [], locations = [], minScore = 0, optedInOnly = true, statuses = [] } = filter;
  const params = [];
  const conds  = ['c.consent_status = \'given\''];

  if (optedInOnly) conds.push('c.opted_in = true');
  if (minScore > 0) { params.push(minScore); conds.push(`c.lead_score >= $${params.length}`); }
  if (segments.length) { params.push(segments); conds.push(`c.segment = ANY($${params.length})`); }
  if (locations.length) {
    const locs = locations.map(l => `%${l.toLowerCase()}%`);
    params.push(locs);
    conds.push(`LOWER(c.location) LIKE ANY($${params.length}::text[])`);
  }

  const { rows } = await query(
    `SELECT id, phone, name FROM customers WHERE ${conds.join(' AND ')} ORDER BY lead_score DESC LIMIT 10000`,
    params
  );
  return rows;
}

// ── Launch broadcast ─────────────────────────────────────────────────────────

async function launch(campaignId) {
  const { rows: camps } = await query('SELECT * FROM campaigns WHERE id=$1', [campaignId]);
  if (!camps.length) throw new Error('Campaign not found');
  const campaign = camps[0];

  // Get config for rate limiting
  const { rows: cfg } = await query('SELECT * FROM outreach_config WHERE id=1');
  const config = cfg[0] || { max_per_day: 500, delay_ms: 1500, send_start_hr: 8, send_end_hr: 20 };

  const recipients = await buildRecipients(campaign.segment_filter || {});
  const capped     = recipients.slice(0, config.max_per_day);

  // Create broadcast record
  const { rows: brows } = await query(
    `INSERT INTO broadcasts (campaign_id, status, started_at) VALUES ($1,'running',NOW()) RETURNING *`,
    [campaignId]
  );
  const broadcast = brows[0];

  // Bulk-insert recipient rows
  if (capped.length) {
    const vals = capped.map((r, i) => {
      const base = i * 3;
      return `($1, $${base + 2}, $${base + 3}, $${base + 4})`;
    });
    const flat = [broadcast.id];
    capped.forEach(r => flat.push(r.id, r.phone, 'pending'));
    // Insert in batches of 500
    for (let i = 0; i < capped.length; i += 500) {
      const batch = capped.slice(i, i + 500);
      const bvals = batch.map((_, j) => {
        const b = j * 3;
        return `($1, $${b + 2}, $${b + 3}, 'pending')`;
      }).join(',');
      const bflat = [broadcast.id];
      batch.forEach(r => { bflat.push(r.id); bflat.push(r.phone); });
      await query(`INSERT INTO broadcast_recipients (broadcast_id, customer_id, phone, status) VALUES ${bvals} ON CONFLICT DO NOTHING`, bflat);
    }
  }

  // Update campaign
  await query(`UPDATE campaigns SET status='running', total_recipients=$1 WHERE id=$2`, [capped.length, campaignId]);

  // Send async (don't block response)
  sendBroadcastAsync(broadcast.id, campaign, capped, config).catch(err =>
    logger.error('[campaign] broadcast send error', { broadcastId: broadcast.id, error: err.message })
  );

  logger.info('[campaign] broadcast launched', { campaignId, broadcastId: broadcast.id, recipients: capped.length });
  return { broadcastId: broadcast.id, recipientCount: capped.length };
}

async function sendBroadcastAsync(broadcastId, campaign, recipients, config) {
  let sent = 0, failed = 0;

  for (const r of recipients) {
    // Check time window
    const hr = new Date().getHours();
    if (hr < config.send_start_hr || hr >= config.send_end_hr) {
      logger.info('[campaign] outside send window — pausing broadcast');
      break;
    }

    const msg = campaign.message_template
      .replace(/\{\{name\}\}/g,    r.name || 'Customer')
      .replace(/\{\{phone\}\}/g,   r.phone);

    try {
      await whatsapp.sendText(r.phone, msg);
      await query(
        `UPDATE broadcast_recipients SET status='sent', sent_at=NOW() WHERE broadcast_id=$1 AND customer_id=$2`,
        [broadcastId, r.id]
      );
      await query(`UPDATE customers SET last_contact=NOW(), contact_count=contact_count+1 WHERE id=$1`, [r.id]);
      sent++;
    } catch (err) {
      await query(
        `UPDATE broadcast_recipients SET status='failed', error=$1 WHERE broadcast_id=$2 AND customer_id=$3`,
        [err.message, broadcastId, r.id]
      );
      failed++;
    }

    // Rate limit delay
    await new Promise(res => setTimeout(res, config.delay_ms || 1500));
  }

  await query(
    `UPDATE broadcasts SET status='completed', sent_count=$1, failed_count=$2, finished_at=NOW() WHERE id=$3`,
    [sent, failed, broadcastId]
  );
  await query(
    `UPDATE campaigns SET status='completed', sent_count=$1, completed_at=NOW() WHERE id=$2`,
    [sent, campaign.id]
  );
  logger.info('[campaign] broadcast complete', { broadcastId, sent, failed });
}

module.exports = { list, create, update, launch, buildRecipients };
