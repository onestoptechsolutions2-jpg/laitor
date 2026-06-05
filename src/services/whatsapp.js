'use strict';

const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

const BASE_URL = `${config.evolution.url}/message/sendText/${config.evolution.instance}`;

/**
 * Build an Axios instance wired to Evolution API.
 */
const client = axios.create({
  baseURL: config.evolution.url,
  headers: {
    apikey: config.evolution.apiKey,
    'Content-Type': 'application/json',
  },
  timeout: 15000,
});

/**
 * Send a plain-text WhatsApp message with retry logic.
 *
 * @param {string} phone  - International format, e.g. "2547XXXXXXXX"
 * @param {string} text   - Message body
 * @param {number} retries
 */
const sendText = async (phone, text, retries = 3) => {
  const payload = {
    number: phone,
    options: { delay: 500, presence: 'composing' },
    textMessage: { text },
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await client.post(
        `/message/sendText/${config.evolution.instance}`,
        payload
      );
      logger.info('WhatsApp message sent', { phone, attempt });
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      logger.warn('WhatsApp send attempt failed', { phone, attempt, status, error: err.message });

      if (attempt === retries) {
        logger.error('WhatsApp send failed after all retries', { phone });
        throw err;
      }

      // Exponential back-off: 1s, 2s, 4s
      await sleep(1000 * Math.pow(2, attempt - 1));
    }
  }
};

/**
 * Send a list of messages sequentially to the same number.
 * Useful for multi-message flows.
 *
 * @param {string} phone
 * @param {string[]} messages
 */
const sendSequence = async (phone, messages) => {
  for (const msg of messages) {
    await sendText(phone, msg);
    await sleep(700); // small delay between messages
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { sendText, sendSequence };
