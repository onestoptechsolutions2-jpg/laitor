/**
 * leads.js — Lead Scoring Engine
 * Scores customers 0–100 based on recency, engagement, segment, opt-in, location.
 * Mirrors ProspectHub's scoring algorithm, adapted for Laitor's customer table.
 */
'use strict';
const { query } = require('../models/db');
const logger    = require('../utils/logger');

const WEIGHTS = {
  recency:    0.25,  // days since last contact
  engagement: 0.25,  // response rate
  segment:    0.20,  // segment quality
  optIn:      0.15,  // opted-in status
  location:   0.10,  // urban vs rural
  status:     0.05,  // pipeline stage
};

const SEGMENT_SCORE = { salaried:90, sme:80, youth:70, general:50, rural:40 };
const URBAN_KEYWORDS = ['nairobi','mombasa','kisumu','nakuru','eldoret','thika','westlands','cbd'];

function recencyScore(lastContact) {
  if (!lastContact) return 0;
  const days = (Date.now() - new Date(lastContact).getTime()) / 86400000;
  if (days < 1)  return 100;
  if (days < 7)  return 80;
  if (days < 30) return 60;
  if (days < 90) return 30;
  return 10;
}

function engagementScore(contactCount, responseCount) {
  if (!contactCount) return 0;
  const rate = responseCount / contactCount;
  return Math.round(rate * 100);
}

function locationScore(location) {
  if (!location) return 40;
  const loc = location.toLowerCase();
  return URBAN_KEYWORDS.some(k => loc.includes(k)) ? 90 : 40;
}

async function scoreCustomer(customerId) {
  const { rows } = await query(
    `SELECT c.*,
            COUNT(m.id)                                   AS contact_count,
            COUNT(m.id) FILTER (WHERE m.direction='inbound') AS response_count,
            MAX(m.created_at)                             AS last_contact
     FROM customers c
     LEFT JOIN messages m ON m.phone = c.phone
     WHERE c.id = $1
     GROUP BY c.id`,
    [customerId]
  );
  if (!rows.length) return null;
  const c = rows[0];

  const factors = {
    recency:    recencyScore(c.last_contact),
    engagement: engagementScore(+c.contact_count, +c.response_count),
    segment:    SEGMENT_SCORE[c.segment] || 50,
    optIn:      c.opted_in ? 100 : 20,
    location:   locationScore(c.location),
    status:     50,
  };

  const score = Math.round(
    Object.entries(WEIGHTS).reduce((sum, [k, w]) => sum + (factors[k] || 0) * w, 0)
  );

  await query(
    `UPDATE customers SET lead_score=$1, last_contact=$2, contact_count=$3, response_count=$4 WHERE id=$5`,
    [score, c.last_contact, c.contact_count, c.response_count, customerId]
  );
  await query(
    `INSERT INTO lead_score_logs (customer_id, score, factors) VALUES ($1,$2,$3)`,
    [customerId, score, JSON.stringify(factors)]
  );
  return { customerId, score, factors };
}

async function scoreAll({ onlyStale = true } = {}) {
  const where = onlyStale
    ? `WHERE lead_score = 0 OR last_contact > NOW() - INTERVAL '7 days'`
    : '';
  const { rows } = await query(`SELECT id FROM customers ${where} LIMIT 5000`);
  logger.info(`[leads] Scoring ${rows.length} customers…`);
  let done = 0;
  for (const { id } of rows) {
    await scoreCustomer(id).catch(() => {});
    done++;
  }
  logger.info(`[leads] Scored ${done} customers.`);
  return done;
}

module.exports = { scoreCustomer, scoreAll };
