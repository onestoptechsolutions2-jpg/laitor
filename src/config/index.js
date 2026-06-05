'use strict';

require('dotenv').config();

const required = (key) => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
};

const optional = (key, fallback = '') => process.env[key] || fallback;

module.exports = {
  server: {
    port: parseInt(optional('PORT', '3000'), 10),
    env: optional('NODE_ENV', 'development'),
  },

  evolution: {
    url: optional('EVOLUTION_API_URL'),
    apiKey: optional('EVOLUTION_API_KEY'),
    instance: optional('EVOLUTION_INSTANCE', 'laitor'),
  },

  crm: {
    url: optional('CRM_URL'),
    apiKey: optional('CRM_API_KEY'),
  },

  managerIo: {
    url: optional('MANAGER_IO_URL'),
    apiKey: optional('MANAGER_IO_API_KEY'),
  },

  database: {
    url: optional('DATABASE_URL', 'postgresql://laitor:password@localhost:5432/laitor'),
  },

  redis: {
    url: optional('REDIS_URL', 'redis://localhost:6379'),
  },

  webhook: {
    secret: optional('WEBHOOK_SECRET'),
  },

  session: {
    ttl: parseInt(optional('SESSION_TTL_SECONDS', '3600'), 10),
  },
};
