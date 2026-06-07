'use strict';

/**
 * @module sync-queue
 * @description Retry queue for failed CRM and Manager.io sync operations.
 *
 * When a push to Twenty CRM or Manager.io fails, the failed operation is stored
 * in the sync_queue table. A background job (startWorker) retries them every
 * RETRY_INTERVAL_MS milliseconds, up to MAX_ATTEMPTS times.
 *
 * After MAX_ATTEMPTS failures, the item is marked 'dead' for manual review
 * via the admin dashboard.
 *
 * Design: operations are idempotent by entity_type + entity_id + target,
 * so replaying them is safe.
 */

const { query } = require('../models/db');
const logger    = require('../utils/logger');

const MAX_ATTEMPTS      = 3;
const RETRY_INTERVAL_MS = 5 * 60 * 1000;   // 5 minutes
const RETRY_BACKOFF_MS  = 60 * 1000;        // 1-minute backoff per attempt

// ── Enqueue ───────────────────────────────────────────────────────────────────

/**
 * Add a failed sync operation to the retry queue.
 * Safe to call multiple times — duplicate entity+target combinations are
 * upserted (attempt count reset, payload updated).
 *
 * @param {object} params
 * @param {string} params.entityType  - 'customer' | 'lead' | 'order' | 'ticket' | 'quote' | 'agent_notification'
 * @param {string} params.entityId    - Local DB ID or reference string
 * @param {string} params.target      - 'crm' | 'manager' | 'whatsapp'
 * @param {object} params.payload     - Data needed to retry the operation
 * @returns {Promise<void>}
 */
const enqueue = async ({ entityType, entityId, target, payload }) => {
  try {
    await query(
      `INSERT INTO sync_queue (entity_type, entity_id, target, payload, status, attempts, next_retry_at)
       VALUES ($1, $2, $3, $4, 'pending', 0, NOW())
       ON CONFLICT (entity_type, entity_id, target)
       DO UPDATE SET
         payload       = EXCLUDED.payload,
         status        = 'pending',
         last_error    = NULL,
         next_retry_at = NOW(),
         updated_at    = NOW()`,
      [entityType, String(entityId), target, JSON.stringify(payload)]
    );
    logger.debug('sync-queue: enqueued', { entityType, entityId, target });
  } catch (err) {
    // Queue failure must never crash the caller
    logger.error('sync-queue: enqueue failed', { error: err.message });
  }
};

// ── Worker ────────────────────────────────────────────────────────────────────

/**
 * Process pending sync queue items.
 * Called by startWorker on an interval.
 * Retry handlers are registered via registerHandler().
 *
 * @returns {Promise<{processed: number, failed: number}>}
 */
const handlers = {};

/**
 * Register a retry handler for a specific target.
 * @param {string}   target   - 'crm' | 'manager' | 'whatsapp'
 * @param {Function} handler  - async (item) => void — throws on failure
 */
const registerHandler = (target, handler) => {
  handlers[target] = handler;
};

const processQueue = async () => {
  let processed = 0;
  let failed    = 0;

  try {
    const pending = await query(
      `SELECT * FROM sync_queue
       WHERE status IN ('pending', 'retrying')
         AND next_retry_at <= NOW()
         AND attempts < $1
       ORDER BY next_retry_at
       LIMIT 50`,
      [MAX_ATTEMPTS]
    );

    for (const item of pending.rows) {
      try {
        const handler = handlers[item.target];
        if (!handler) {
          logger.warn('sync-queue: no handler for target', { target: item.target, id: item.id });
          continue;
        }

        await query(
          `UPDATE sync_queue SET status = 'retrying', attempts = attempts + 1, updated_at = NOW() WHERE id = $1`,
          [item.id]
        );

        await handler(item);

        await query(
          `UPDATE sync_queue SET status = 'completed', updated_at = NOW() WHERE id = $1`,
          [item.id]
        );
        processed++;
        logger.info('sync-queue: item completed', { id: item.id, target: item.target });
      } catch (err) {
        const attempts    = (item.attempts || 0) + 1;
        const isExhausted = attempts >= MAX_ATTEMPTS;
        const nextRetry   = new Date(Date.now() + RETRY_BACKOFF_MS * attempts);

        await query(
          `UPDATE sync_queue
           SET status = $1, last_error = $2, next_retry_at = $3, updated_at = NOW()
           WHERE id = $4`,
          [isExhausted ? 'dead' : 'pending', err.message, nextRetry.toISOString(), item.id]
        );
        failed++;
        logger.warn('sync-queue: item failed', { id: item.id, attempts, isExhausted, error: err.message });
      }
    }
  } catch (err) {
    logger.error('sync-queue: processQueue error', { error: err.message });
  }

  return { processed, failed };
};

// ── Background worker ─────────────────────────────────────────────────────────

let workerTimer = null;

/**
 * Start the background retry worker.
 * Should be called once on app startup.
 * Safe to call multiple times — only one worker runs at a time.
 */
const startWorker = () => {
  if (workerTimer) return;
  logger.info('sync-queue: worker started', { intervalMs: RETRY_INTERVAL_MS });
  workerTimer = setInterval(async () => {
    const result = await processQueue();
    if (result.processed > 0 || result.failed > 0) {
      logger.info('sync-queue: worker run complete', result);
    }
  }, RETRY_INTERVAL_MS);

  // Prevent the worker timer from keeping the process alive
  if (workerTimer.unref) workerTimer.unref();
};

/**
 * Stop the background worker (for clean shutdown).
 */
const stopWorker = () => {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
};

// ── Stats ─────────────────────────────────────────────────────────────────────

/**
 * Return queue statistics for the admin dashboard.
 * @returns {Promise<object>}
 */
const getStats = async () => {
  try {
    const res = await query(
      `SELECT status, COUNT(*) AS count FROM sync_queue GROUP BY status`
    );
    const stats = { pending: 0, retrying: 0, completed: 0, dead: 0 };
    for (const row of res.rows) { stats[row.status] = parseInt(row.count); }
    return stats;
  } catch (err) {
    logger.warn('sync-queue: getStats failed', { error: err.message });
    return {};
  }
};

module.exports = { enqueue, registerHandler, processQueue, startWorker, stopWorker, getStats };
