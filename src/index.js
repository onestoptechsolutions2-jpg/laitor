'use strict';

/**
 * @file index.js
 * @description Laitor WhatsApp Engine -- application entry point.
 *
 * Startup sequence:
 *   1. Wait for database (retry loop, 10 x 3s)
 *   2. Seed bot config defaults
 *   3. Start sync-queue retry worker
 *   4. Start bidirectional sync worker (Twenty CRM <-> Manager.io) -- non-fatal
 *   5. Start HTTP server
 */

require('dotenv').config();

const express = require('express');
const path    = require('path');
const config  = require('./config');
const logger  = require('./utils/logger');
const { pool }       = require('./models/db');
const session        = require('./services/session');
const syncQueue      = require('./services/sync-queue');
const cfgStore       = require('./services/config-store');
const biSync         = require('./services/bidirectional-sync');

const webhookRouter  = require('./routes/webhook');
const contactsRouter = require('./routes/contacts');
const webLeadRouter  = require('./routes/weblead');
const apiRouter      = require('./routes/api');
const { router: authRouter } = require('./routes/auth');

const app = express();

// ---- Middleware ---------------------------------------------------------------

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((req, _res, next) => {
  logger.debug(req.method + ' ' + req.path);
  next();
});

// ---- Routes ------------------------------------------------------------------

app.get('/health', async (_req, res) => {
  let dbOk = false;
  try { await pool.query('SELECT 1'); dbOk = true; } catch (_) {}
  res.json({
    status:  'ok',
    db:      dbOk ? 'connected' : 'error',
    uptime:  process.uptime(),
    env:     config.server.env,
    version: process.env.npm_package_version || '1.0.0',
  });
});

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

app.use('/webhook/whatsapp', webhookRouter);
app.use('/contacts',         contactsRouter);
app.use('/leads',            webLeadRouter);
app.use('/auth',             authRouter);
app.use('/api/v1',           apiRouter);

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, _req, res, _next) => {
  logger.error('Unhandled express error', { error: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

// ---- Startup -----------------------------------------------------------------

const waitForDB = async (retries, delayMs) => {
  retries = retries || 10;
  delayMs = delayMs || 3000;
  for (var i = 1; i <= retries; i++) {
    try {
      await pool.query('SELECT 1');
      logger.info('Database connected');
      return;
    } catch (err) {
      logger.warn('DB not ready (' + i + '/' + retries + '): ' + err.message);
      if (i === retries) throw err;
      await new Promise(function(r) { setTimeout(r, delayMs); });
    }
  }
};

const start = async () => {
  try {
    await waitForDB();
    await cfgStore.seedDefaults();

    syncQueue.startWorker();
    logger.info('Sync-queue worker started');

    // Non-fatal: sync worker failure must not prevent server from starting
    try {
      await biSync.startWorker();
      logger.info('Bidirectional sync worker initialised');
    } catch (syncErr) {
      logger.warn('Bidirectional sync worker failed to start (non-fatal)', { error: syncErr.message });
    }

    app.listen(config.server.port, () => {
      logger.info('Laitor WhatsApp Engine started', {
        port: config.server.port,
        env:  config.server.env,
      });
    });
  } catch (err) {
    logger.error('Startup failed: ' + err.message);
    process.exit(1);
  }
};

// ---- Shutdown ----------------------------------------------------------------

const shutdown = async (signal) => {
  logger.info(signal + ' received -- shutting down');
  syncQueue.stopWorker();
  try {
    await pool.end();
    await session.disconnect();
    process.exit(0);
  } catch (err) {
    logger.error('Shutdown error: ' + err.message);
    process.exit(1);
  }
};

process.on('SIGTERM', function() { shutdown('SIGTERM'); });
process.on('SIGINT',  function() { shutdown('SIGINT'); });

start();
