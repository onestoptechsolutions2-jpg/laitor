'use strict';

const axios  = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

const client = axios.create({
  baseURL: config.evolution.url,
  headers: {
    apikey: config.evolution.apiKey,
    'Content-Type': 'application/json',
  },
  timeout: 15000,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Plain text ────────────────────────────────────────────────────────────────

const sendText = async (phone, text, retries = 3) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await client.post(`/message/sendText/${config.evolution.instance}`, { number: phone, text });
      logger.info('WhatsApp message sent', { phone, attempt });
      return res.data;
    } catch (err) {
      logger.warn('WhatsApp send attempt failed', { phone, attempt, status: err.response?.status, error: err.message });
      if (attempt === retries) throw err;
      await sleep(1000 * Math.pow(2, attempt - 1));
    }
  }
};

// ── Button message (2–3 options) ──────────────────────────────────────────────
// payload: { title, body, footer?, buttons: [{ id, label }] }

const sendButtons = async (phone, payload, retries = 3) => {
  const body = {
    number:      phone,
    title:       payload.title || '',
    description: payload.body  || '',
    footer:      payload.footer || 'Laitor Invest',
    buttons: (payload.buttons || []).map((b) => ({
      buttonId:   String(b.id),
      buttonText: { displayText: b.label },
      type: 1,
    })),
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await client.post(`/message/sendButtons/${config.evolution.instance}`, body);
      logger.info('WhatsApp buttons sent', { phone, attempt });
      return res.data;
    } catch (err) {
      logger.warn('WhatsApp buttons attempt failed', { phone, attempt, status: err.response?.status, error: err.message, response: err.response?.data });
      if (attempt === retries) {
        // Fallback to plain text
        logger.warn('Falling back to plain text for buttons', { phone });
        const textFallback = (payload.title ? payload.title + '\n\n' : '') +
          (payload.body ? payload.body + '\n\n' : '') +
          (payload.buttons || []).map((b) => `*${b.id}.* ${b.label}`).join('\n');
        return sendText(phone, textFallback);
      }
      await sleep(800);
    }
  }
};

// ── List message (4–10 options) ───────────────────────────────────────────────
// payload: { title, body, footer?, buttonText?, sections: [{ title, rows: [{ id, title, description? }] }] }

const sendList = async (phone, payload, retries = 3) => {
  const body = {
    number:      phone,
    title:       payload.title      || '',
    description: payload.body       || '',
    footer:      payload.footer     || 'Laitor Invest',
    buttonText:  payload.buttonText || 'Select',
    sections:    (payload.sections  || []).map((s) => ({
      title: s.title || '',
      rows:  (s.rows || []).map((r) => ({
        rowId:       String(r.id),
        title:       r.title,
        description: r.description || '',
      })),
    })),
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await client.post(`/message/sendList/${config.evolution.instance}`, body);
      logger.info('WhatsApp list sent', { phone, attempt });
      return res.data;
    } catch (err) {
      logger.warn('WhatsApp list attempt failed', { phone, attempt, status: err.response?.status, error: err.message, response: err.response?.data });
      if (attempt === retries) {
        // Fallback to plain text
        logger.warn('Falling back to plain text for list', { phone });
        const rows = (payload.sections || []).flatMap((s) => s.rows || []);
        const textFallback = (payload.title ? '*' + payload.title + '*\n\n' : '') +
          (payload.body ? payload.body + '\n\n' : '') +
          rows.map((r) => `*${r.id}.* ${r.title}${r.description ? ' — ' + r.description : ''}`).join('\n');
        return sendText(phone, textFallback);
      }
      await sleep(800);
    }
  }
};

// ── Generic interactive dispatcher ───────────────────────────────────────────
// msg: { type: 'text'|'buttons'|'list', ...payload }

const sendInteractive = async (phone, msg) => {
  if (!msg || typeof msg === 'string') return sendText(phone, msg);
  if (msg.type === 'buttons') return sendButtons(phone, msg);
  if (msg.type === 'list')    return sendList(phone, msg);
  if (msg.type === 'text')    return sendText(phone, msg.text || msg.body || '');
  return sendText(phone, JSON.stringify(msg));
};

// ── Sequence helpers ──────────────────────────────────────────────────────────

const sendSequence = async (phone, messages) => {
  for (const msg of messages) {
    if (typeof msg === 'string') {
      await sendText(phone, msg);
    } else {
      await sendInteractive(phone, msg);
    }
    await sleep(700);
  }
};

module.exports = { sendText, sendButtons, sendList, sendInteractive, sendSequence };
