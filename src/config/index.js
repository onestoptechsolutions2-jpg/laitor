'use strict';

require('dotenv').config();

const optional = (key, fallback) => process.env[key] || fallback || '';

module.exports = {
  server: {
    port: parseInt(optional('PORT', '3000'), 10),
    env:  optional('NODE_ENV', 'development'),
  },
  evolution: {
    url:      optional('EVOLUTION_API_URL'),
    apiKey:   optional('EVOLUTION_API_KEY'),
    instance: optional('EVOLUTION_INSTANCE', 'laitor'),
  },
  crm: {
    url:    optional('CRM_URL'),
    apiKey: optional('CRM_API_KEY'),
  },
  database: {
    url: optional('DATABASE_URL', 'postgresql://laitor:laitor2024@laitor_db:5432/laitor'),
  },
  redis: {
    url: optional('REDIS_URL', 'redis://laitor_cache:6379'),
  },
  manager: {
    // MANAGER_URL = full API2 endpoint, e.g. http://finance360.laitor.co.ke/api2
    // MANAGER_API_KEY = access token from Manager.io Settings → API
    url:    optional('MANAGER_URL'),
    apiKey: optional('MANAGER_API_KEY'),
  },
  webhook: {
    secret: optional('WEBHOOK_SECRET', 'laitor_webhook_secret'),
  },
  session: {
    ttl: parseInt(optional('SESSION_TTL_SECONDS', '3600'), 10),
  },
};
