'use strict';

/**
 * Web lead route — captures leads from website, referrals, and social media.
 * POST /leads/web
 *
 * Body:
 *   phone       (required)  — customer phone number
 *   name        (optional)
 *   service     (optional)  — service they are interested in
 *   location    (optional)
 *   source      (optional)  — 'website' | 'referral' | 'social' | 'walk-in' (default: 'website')
 *   referred_by (optional)  — phone of referrer
 *   notes       (optional)
 */

const express  = require('express');
const { query } = require('../models/db');
const crm      = require('../services/crm');
const consent  = require('../services/consent');
const whatsapp = require('../services/whatsapp');
const menu     = require('../services/menu');
const session  = require('../services/session');
const admin    = require('../services/admin');
const logger   = require('../utils/logger');

const router = express.Router();

const sanitisePhone = (raw) => {
  if (!raw) return null;
  let p = String(raw).replace(/\D/g, '');
  if (p.startsWith('0'))   p = '254' + p.slice(1);
  if (p.startsWith('254')) return p;
  if (p.length === 9)      return '254' + p;
  return p.length >= 10 ? p : null;
};

router.post('/web', async (req, res) => {
  const { name, service, location, source, referred_by, notes } = req.body || {};
  const phone = sanitisePhone(req.body.phone);

  if (!phone) {
    return res.status(400).json({ error: 'Valid phone number is required.' });
  }

  try {
    // Upsert customer
    const r = await query(
      `INSERT INTO customers (phone, name, service_tag, location, source, consent_status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       ON CONFLICT (phone) DO UPDATE SET
         name        = COALESCE(EXCLUDED.name, customers.name),
         service_tag = COALESCE(EXCLUDED.service_tag, customers.service_tag),
         location    = COALESCE(EXCLUDED.location, customers.location),
         source      = COALESCE(EXCLUDED.source, customers.source),
         updated_at  = NOW()
       RETURNING *`,
      [phone, name || null, service || null, location || null, source || 'website']
    );
    const customer = r.rows[0];

    // Store referral if provided
    if (referred_by) {
      const refPhone = sanitisePhone(referred_by);
      if (refPhone) {
        await query(
          `INSERT INTO customers (phone, source) VALUES ($1, 'referrer')
           ON CONFLICT (phone) DO NOTHING`,
          [refPhone]
        );
        await query(
          `UPDATE customers SET referred_by = $1 WHERE phone = $2`,
          [refPhone, phone]
        ).catch(() => {}); // column may not exist yet — non-fatal
      }
    }

    // Sync to CRM
    const crmPersonId = await crm.upsertPerson({ phone, name });
    if (crmPersonId) {
      await crm.createLead({
        crmPersonId,
        type: 'WEB_LEAD',
        notes: [
          source ? 'Source: ' + source : null,
          service ? 'Service: ' + service : null,
          location ? 'Location: ' + location : null,
          referred_by ? 'Referred by: ' + referred_by : null,
          notes || null,
        ].filter(Boolean).join(' | '),
      });
    }

    // Notify admin
    await admin.notifyNewLead({
      leadId: customer.id,
      phone,
      name: name || phone,
      message: `[${(source || 'website').toUpperCase()}] ${service || ''} ${location || ''} ${notes || ''}`.trim(),
    });

    // Send WhatsApp consent message if not yet consented
    const consentStatus = customer.consent_status || 'pending';
    if (consentStatus === 'pending') {
      const sess = await session.get(phone);
      if (!sess.consentSent) {
        await whatsapp.sendSequence(phone, consent.CONSENT_MESSAGE).catch((err) => {
          logger.warn('Could not send consent WhatsApp to web lead', { phone, error: err.message });
        });
        await session.set(phone, { ...sess, state: 'CONSENT_PENDING', consentSent: true, customerId: customer.id });
      }
    } else if (consentStatus === 'given') {
      // Already consented — drop them straight into main menu
      await whatsapp.sendSequence(phone, [
        `Hello ${name || 'there'}! We received your enquiry on our website. 👋`,
        ...menu.MAIN_MENU,
      ]).catch(() => {});
    }

    logger.info('Web lead created', { phone, source, service });

    return res.json({
      success: true,
      message: 'Lead captured. WhatsApp message sent.',
      customerId: customer.id,
      phone,
    });
  } catch (err) {
    logger.error('Web lead failed', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /leads/sources
 * Returns lead counts grouped by source — for the dashboard.
 */
router.get('/sources', async (_req, res) => {
  try {
    const r = await query(
      `SELECT source, COUNT(*) AS count FROM customers GROUP BY source ORDER BY count DESC`
    );
    return res.json({ sources: r.rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
