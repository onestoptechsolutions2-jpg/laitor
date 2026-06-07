'use strict';

const axios = require('axios');
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

const sendText = async (phone, text, retries = 3) => {
  const payload = { number: phone, text };

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
      logger.warn('WhatsApp send attempt failed', {
        phone, attempt, status, error: err.message, response: err.response?.data,
      });
      if (attempt === retries) {
        logger.error('WhatsApp send failed after all retries', { phone });
        throw err;
      }
      await sleep(1000 * Math.pow(2, attempt - 1));
    }
  }
};

const sendSequence = async (phone, messages) => {
  for (const msg of messages) {
    await sendText(phone, msg);
    await sleep(700);
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { sendText, sendSequence };
