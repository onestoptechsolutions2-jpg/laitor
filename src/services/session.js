'use strict';

const Redis = require('ioredis');
const config = require('../config');
const logger = require('../utils/logger');

let client;

const getClient = () => {
  if (!client) {
    client = new Redis(config.redis.url, {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });

    client.on('connect', () => logger.info('Redis connected'));
    client.on('error', (err) => logger.error('Redis error', { error: err.message }));
    client.on('reconnecting', () => logger.warn('Redis reconnecting...'));
  }
  return client;
};

/**
 * Load session data for a phone number.
 * @param {string} phone
 * @returns {Promise<object>}
 */
const get = async (phone) => {
  try {
    const raw = await getClient().get(`session:${phone}`);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    logger.error('Session get failed', { phone, error: err.message });
    return {};
  }
};

/**
 * Merge data into an existing session and reset TTL.
 * @param {string} phone
 * @param {object} data
 */
const set = async (phone, data) => {
  try {
    const existing = await get(phone);
    const merged = { ...existing, ...data, updatedAt: new Date().toISOString() };
    await getClient().setex(`session:${phone}`, config.session.ttl, JSON.stringify(merged));
    logger.debug('Session updated', { phone });
  } catch (err) {
    logger.error('Session set failed', { phone, error: err.message });
  }
};

/**
 * Delete a session (e.g. after conversation resolved).
 * @param {string} phone
 */
const clear = async (phone) => {
  try {
    await getClient().del(`session:${phone}`);
    logger.debug('Session cleared', { phone });
  } catch (err) {
    logger.error('Session clear failed', { phone, error: err.message });
  }
};

/**
 * Close Redis connection gracefully.
 */
const disconnect = async () => {
  if (client) {
    await client.quit();
    client = null;
  }
};

module.exports = { get, set, clear, disconnect };
