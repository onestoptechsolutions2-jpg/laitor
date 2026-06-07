'use strict';

require('dotenv').config();

const express = require('express');
const config  = require('./config');
const logger  = require('./utils/logger');
const { pool } = require('./models/db');
const session  = require('./services/session');
const webhookRouter  = require('./routes/webhook');
const contactsRouter = require('./routes/contacts');

const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  logger.debug(req.method + ' ' + req.path);
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', async (_req, res) => {
  let dbOk = false;
  try { await pool.query('SELECT 1'); dbOk = true; } catch (_) {}
  res.json({ status: 'ok', db: dbOk ? 'connected' : 'error', uptime: process.uptime(), env: config.server.env });
});

app.use('/webhook/whatsapp', webhookRouter);
app.use('/contacts', contactsRouter);

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, _req, res, _next) => {
  logger.error('Unhandled express error', { error: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Startup ──────────────────────────────────────────────────────────────────

const start = async () => {
  try {
    await pool.query('SELECT 1');
    logger.info('Database connected');
    app.listen(config.server.port, () => {
      logger.info('Laitor WhatsApp Engine started', { port: config.server.port, env: config.server.env });
    });
  } catch (err) {
    logger.error('Startup failed', { error: err.message });
    process.exit(1);
  }
};

const shutdown = async (signal) => {
  logger.info(signal + ' received — shutting down');
  try {
    await pool.end();
    await session.disconnect();
    process.exit(0);
  } catch (err) {
    logger.error('Shutdown error', { error: err.message });
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

start();
