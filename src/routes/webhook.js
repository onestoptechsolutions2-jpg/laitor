'use strict';

const express      = require('express');
const orchestrator = require('../orchestrator');
const logger       = require('../utils/logger');

const router = express.Router();

/**
 * Normalise Evolution API v2 webhook payload → internal message object.
 * Handles: plain text, extended text, button tap replies, list tap replies.
 */
const normalise = (body) => {
  try {
    const data = body?.data;
    const key  = data?.key;
    const msg  = data?.message;

    if (!key || !msg)                    return null;
    if (key.fromMe === true)             return null;
    if (body.event !== 'messages.upsert') return null;

    const phone = key.remoteJid?.replace('@s.whatsapp.net', '');
    if (!phone) return null;

    // Extract text — try all known message types
    const text =
      msg.conversation                                          ||  // plain text
      msg.extendedTextMessage?.text                            ||  // link/formatted text
      msg.buttonsResponseMessage?.selectedButtonId             ||  // button tap → use the ID as the reply
      msg.listResponseMessage?.singleSelectReply?.selectedRowId || // list tap → row ID
      msg.imageMessage?.caption                                ||
      msg.documentMessage?.caption                             ||
      '';

    if (!text.trim()) return null;

    const msgId = key.id || `${phone}-${Date.now()}`;
    const name  = data?.pushName || null;

    return { phone, name, text: text.trim(), msgId, raw: body };
  } catch (err) {
    logger.warn('Payload normalisation failed', { error: err.message });
    return null;
  }
};

router.post('/', async (req, res) => {
  res.status(200).json({ status: 'received' });

  const msg = normalise(req.body);
  if (!msg) {
    logger.debug('Webhook: non-processable event skipped', { event: req.body?.event });
    return;
  }

  logger.info('Webhook: inbound message received', { phone: msg.phone, msgId: msg.msgId });

  setImmediate(async () => {
    try {
      await orchestrator.process(msg);
    } catch (err) {
      logger.error('Orchestrator unhandled error', { error: err.message, stack: err.stack });
    }
  });
});

module.exports = router;
