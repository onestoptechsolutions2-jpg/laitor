'use strict';

const { query } = require('../models/db');
const logger = require('../utils/logger');

const TICKET_STATUS = {
  OPEN:        'open',
  IN_PROGRESS: 'in_progress',
  RESOLVED:    'resolved',
  CLOSED:      'closed',
};

const PRIORITY = {
  LOW:    'low',
  MEDIUM: 'medium',
  HIGH:   'high',
};

/**
 * Infer ticket priority from issue text.
 * Escalate to HIGH if keywords suggest total outage or urgency.
 *
 * @param {string} text
 * @returns {string}
 */
const inferPriority = (text) => {
  const n = (text || '').toLowerCase();
  const highSignals = ['no internet', 'completely down', 'total outage', 'urgent', 'emergency', 'no connection', 'not working at all'];
  const lowSignals  = ['slow', 'sometimes', 'occasional', 'minor'];

  if (highSignals.some((kw) => n.includes(kw))) return PRIORITY.HIGH;
  if (lowSignals.some((kw) => n.includes(kw)))  return PRIORITY.LOW;
  return PRIORITY.MEDIUM;
};

/**
 * Create a new support ticket.
 *
 * @param {{ customerId: number, issue: string, crmTicketId?: string }} params
 * @returns {Promise<object>}
 */
const create = async ({ customerId, issue, crmTicketId }) => {
  const priority = inferPriority(issue);
  const res = await query(
    `INSERT INTO tickets (customer_id, issue, priority, status, crm_ticket_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [customerId, issue, priority, TICKET_STATUS.OPEN, crmTicketId || null]
  );
  const ticket = res.rows[0];
  logger.info('Ticket created', { ticketId: ticket.id, priority, customerId });
  return ticket;
};

/**
 * Update ticket status and optionally assign a technician.
 *
 * @param {number} ticketId
 * @param {string} status
 * @param {string} [technician]
 * @returns {Promise<object|null>}
 */
const updateStatus = async (ticketId, status, technician) => {
  const res = await query(
    `UPDATE tickets
     SET status = $1,
         technician = COALESCE($2, technician),
         updated_at = NOW()
     WHERE id = $3
     RETURNING *`,
    [status, technician || null, ticketId]
  );
  if (!res.rows.length) {
    logger.warn('Ticket not found for status update', { ticketId });
    return null;
  }
  logger.info('Ticket status updated', { ticketId, status, technician });
  return res.rows[0];
};

/**
 * Fetch a ticket by ID (with customer details).
 *
 * @param {number} ticketId
 * @returns {Promise<object|null>}
 */
const getById = async (ticketId) => {
  const res = await query(
    `SELECT t.*, c.phone, c.name
     FROM tickets t
     JOIN customers c ON c.id = t.customer_id
     WHERE t.id = $1`,
    [ticketId]
  );
  return res.rows[0] || null;
};

/**
 * Fetch all open/in-progress tickets for admin.
 *
 * @returns {Promise<object[]>}
 */
const getOpen = async () => {
  const res = await query(
    `SELECT t.*, c.phone, c.name
     FROM tickets t
     JOIN customers c ON c.id = t.customer_id
     WHERE t.status IN ('open', 'in_progress')
     ORDER BY
       CASE t.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
       t.created_at ASC
     LIMIT 50`
  );
  return res.rows;
};

module.exports = { create, updateStatus, getById, getOpen, TICKET_STATUS, PRIORITY };
