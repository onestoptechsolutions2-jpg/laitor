'use strict';

const express = require('express');
const orchestrator = require('../orchestrator');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Normalise an Evolution API webhook payload into a clean internal message object.
 * Evolution API v2 sends a nested structure — we extract only what we need.
 *
 * @param {object} body - Raw webhook body
 * @returns {{ phone, name, text, msgId, raw } | null}
 */
const normalise = (body) => {
  try {
    // Evolution API v2 structure
    const data = body?.data;
    const key = data?.key;
    const msg = data?.message;

    // Only handle incoming text messages (ignore status updates, receipts, etc.)
    if (!key || !msg) return null;
    if (key.fromMe === true) return null;         // Ignore our own outbound messages
    if (body.event !== 'messages.upsert') return null;

    const phone = key.remoteJid?.replace('@s.whatsapp.net', '');
    if (!phone) return null;

    // Extract text (handles plain text, extended text, and image captions)
    const text =
      msg.conversation ||
      msg.extendedTextMessage?.text ||
      msg.imageMessage?.caption ||
      msg.documentMessage?.caption ||
      '';

    if (!text.trim()) return null; // Skip non-text messages for now

    const msgId = key.id || `${phone}-${Date.now()}`;
    const name = data?.pushName || null;

    return { phone, name, text: text.trim(), msgId, raw: body };
  } catch (err) {
    logger.warn('Payload normalisation failed', { error: err.message });
    return null;
  }
};

/**
 * POST /webhook/whatsapp
 * Evolution API sends all events here.
 */
router.post('/', async (req, res) => {
  // Acknowledge immediately — Evolution API expects a fast 200
  res.status(200).json({ status: 'received' });

  const msg = normalise(req.body);
  if (!msg) {
    logger.debug('Webhook: non-processable event skipped', { event: req.body?.event });
    return;
  }

  logger.info('Webhook: inbound message received', { phone: msg.phone, msgId: msg.msgId });

  // Process asynchronously — response already sent
  setImmediate(async () => {
    try {
      await orchestrator.process(msg);
    } catch (err) {
      logger.error('Orchestrator unhandled error', { error: err.message, stack: err.stack });
    }
  });
});

module.exports = router;
