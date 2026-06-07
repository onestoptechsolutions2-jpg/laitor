'use strict';

/**
 * @file index.js
 * @description Laitor WhatsApp Engine — application entry point.
 *
 * Starts the Express HTTP server and registers all routes.
 * Also starts the sync-queue background retry worker on boot.
 *
 * Startup sequence:
 *   1. Verify database connection
 *   2. Start sync-queue retry worker (retries failed CRM/Manager.io pushes every 5 min)
 *   3. Start HTTP server
 *
 * Shutdown sequence (SIGTERM / SIGINT):
 *   1. Close PostgreSQL pool
 *   2. Disconnect Redis
 *   3. Stop sync-queue worker
 *   4. Exit cleanly
 */

require('dotenv').config();

const express = require('express');
const path    = require('path');
const config  = require('./config');
const logger  = require('./utils/logger');
const { pool }       = require('./models/db');
const session        = require('./services/session');
const syncQueue      = require('./services/sync-queue');

const webhookRouter  = require('./routes/webhook');
const contactsRouter = require('./routes/contacts');
const webLeadRouter  = require('./routes/weblead');
const apiRouter      = require('./routes/api');

const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((req, _res, next) => {
  logger.debug(req.method + ' ' + req.path);
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /health — liveness + readiness check.
 * Used by Coolify health checks and Docker healthcheck CMD.
 */
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

// Admin dashboard SPA
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

app.use('/webhook/whatsapp', webhookRouter);
app.use('/contacts',         contactsRouter);
app.use('/leads',            webLeadRouter);
app.use('/api/v1',           apiRouter);

// 404 handler
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Global error handler
app.use((err, _req, res, _next) => {
  logger.error('Unhandled express error', { error: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Startup ──────────────────────────────────────────────────────────────────

const start = async () => {
  try {
    await pool.query('SELECT 1');
    logger.info('Database connected');

    // Start background sync retry worker
    syncQueue.startWorker();
    logger.info('Sync-queue worker started');

    app.listen(config.server.port, () => {
      logger.info('Laitor WhatsApp Engine started', {
        port: config.server.port,
        env:  config.server.env,
      });
    });
  } catch (err) {
    logger.error('Startup failed', { error: err.message });
    process.exit(1);
  }
};

const shutdown = async (signal) => {
  logger.info(`${signal} received — shutting down`);
  syncQueue.stopWorker();
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
