'use strict';

/**
 * @module bidirectional-sync
 * @description Bidirectional sync between Twenty CRM and Manager.io.
 *
 * Architecture:
 *   - Local PostgreSQL `customers` table is the hub.
 *   - crm_id      = Twenty CRM person ID
 *   - manager_key = Manager.io customer key
 *
 * Sync phases (run in sequence):
 *   1. LOCAL → CRM     Push customers without crm_id to Twenty CRM
 *   2. LOCAL → MANAGER Push customers without manager_key to Manager.io
 *   3. CRM  → LOCAL    Pull Twenty people not in local DB (new phone), create locally + push to Manager
 *   4. MANAGER → LOCAL Pull Manager.io customers not in local DB, create locally + push to CRM
 *
 * Phone is the universal deduplication key (normalized: digits only, no +).
 *
 * Config keys (stored in bot_config via config-store):
 *   sync_enabled       — 'true' | 'false'
 *   sync_interval_min  — '0' (manual only) | '15' | '30' | '60' | '360' | '1440'
 *   sync_last_run      — ISO timestamp of last completed run
 *   sync_last_stats    — JSON string of last run stats
 */

const { query }  = require('../models/db');
const crm        = require('./crm');
const manager    = require('./manager');
const cfgStore   = require('./config-store');
const logger     = require('../utils/logger');

// ── Phone normalisation ───────────────────────────────────────────────────────

const normalizePhone = (p) =>
  String(p || '').replace(/\D/g, '').replace(/^0/, '254');

// ── Manager.io pagination ─────────────────────────────────────────────────────

/**
 * Fetch all Manager.io customers handling pagination.
 * Manager.io returns { customers: [...], totalRecords: N, pageSize: 50 }.
 */
const fetchAllManagerCustomers = async () => {
  const client = manager.client();
  if (!manager.isConfigured()) return [];

  const all  = [];
  let   skip = 0;

  try {
    while (true) {
      const res  = await client.get(`/customers?skip=${skip}`);
      const page = Array.isArray(res.data)
        ? res.data
        : (res.data.customers || []);

      all.push(...page);

      const total = res.data.totalRecords || page.length;
      skip += page.length;
      if (all.length >= total || page.length === 0) break;
    }
    logger.debug('Sync: fetched Manager.io customers', { count: all.length });
  } catch (err) {
    logger.warn('Sync: fetchAllManagerCustomers failed', { error: err.message });
  }
  return all;
};

// ── Twenty CRM pagination ─────────────────────────────────────────────────────

const GQL_PEOPLE = `
  query SyncPeople($after: String) {
    people(first: 50, after: $after, orderBy: { createdAt: DescNullsLast }) {
      edges {
        node {
          id
          name { firstName lastName }
          phones { primaryPhoneNumber }
          emails { primaryEmail }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/**
 * Fetch all Twenty CRM people (cursor pagination).
 */
const fetchAllCrmPeople = async () => {
  if (!require('../config').crm.url || !require('../config').crm.apiKey) return [];

  const all    = [];
  let   cursor = null;
  const axios  = require('axios');
  const config = require('../config');

  try {
    while (true) {
      const res = await axios.post(
        `${config.crm.url}/graphql`,
        { query: GQL_PEOPLE, variables: { after: cursor } },
        {
          headers: { Authorization: `Bearer ${config.crm.apiKey}`, 'Content-Type': 'application/json' },
          timeout: 15000,
        }
      );
      if (res.data.errors?.length) throw new Error(res.data.errors.map(e => e.message).join('; '));

      const { edges, pageInfo } = res.data.data.people;
      all.push(...edges.map(e => e.node));

      if (!pageInfo.hasNextPage) break;
      cursor = pageInfo.endCursor;
    }
    logger.debug('Sync: fetched CRM people', { count: all.length });
  } catch (err) {
    logger.warn('Sync: fetchAllCrmPeople failed', { error: err.message });
  }
  return all;
};

// ── Core sync ─────────────────────────────────────────────────────────────────

/**
 * Run the full bidirectional sync.
 * Returns a stats object with counts per phase.
 */
const runSync = async () => {
  const stats = {
    startedAt:       new Date().toISOString(),
    localToCrm:      0,
    localToManager:  0,
    crmToLocal:      0,
    managerToLocal:  0,
    errors:          [],
  };

  logger.info('Bidirectional sync: starting');

  // ── Phase 1: LOCAL → CRM ─────────────────────────────────────────────────
  try {
    const rows = await query(
      `SELECT id, phone, name, location FROM customers WHERE crm_id IS NULL ORDER BY created_at ASC`
    );
    for (const c of rows.rows) {
      try {
        const crmId = await crm.upsertPerson({ phone: c.phone, name: c.name });
        if (crmId) {
          await query(`UPDATE customers SET crm_id = $1, updated_at = NOW() WHERE id = $2`, [crmId, c.id]);
          if (c.location) await crm.updatePerson(crmId, { location: c.location }).catch(() => {});
          stats.localToCrm++;
        }
      } catch (err) { stats.errors.push({ phase: 'localToCrm', phone: c.phone, error: err.message }); }
    }
  } catch (err) { stats.errors.push({ phase: 'localToCrm', error: err.message }); }

  // ── Phase 2: LOCAL → MANAGER ──────────────────────────────────────────────
  try {
    const rows = await query(
      `SELECT id, phone, name FROM customers WHERE manager_key IS NULL ORDER BY created_at ASC`
    );
    for (const c of rows.rows) {
      try {
        const key = await manager.upsertCustomer({ phone: c.phone, name: c.name });
        if (key) {
          await query(`UPDATE customers SET manager_key = $1, updated_at = NOW() WHERE id = $2`, [key, c.id]);
          stats.localToManager++;
        }
      } catch (err) { stats.errors.push({ phase: 'localToManager', phone: c.phone, error: err.message }); }
    }
  } catch (err) { stats.errors.push({ phase: 'localToManager', error: err.message }); }

  // ── Phase 3: CRM → LOCAL (+ push new ones to Manager) ────────────────────
  try {
    const crmPeople = await fetchAllCrmPeople();
    for (const person of crmPeople) {
      const phone = normalizePhone(person.phones?.primaryPhoneNumber);
      if (!phone || phone.length < 9) continue;
      const name = [person.name?.firstName, person.name?.lastName].filter(Boolean).join(' ') || phone;

      try {
        const existing = await query(`SELECT id, manager_key FROM customers WHERE phone = $1`, [phone]);
        if (existing.rows.length === 0) {
          // New person from CRM — create locally
          const ins = await query(
            `INSERT INTO customers (phone, name, crm_id, source, consent_status, created_at, updated_at)
             VALUES ($1, $2, $3, 'crm_import', 'given', NOW(), NOW())
             ON CONFLICT (phone) DO UPDATE SET crm_id = EXCLUDED.crm_id, updated_at = NOW()
             RETURNING id, manager_key`,
            [phone, name, person.id]
          );
          stats.crmToLocal++;

          // Also push to Manager.io if not already there
          if (!ins.rows[0]?.manager_key) {
            const key = await manager.upsertCustomer({ phone, name }).catch(() => null);
            if (key) {
              await query(`UPDATE customers SET manager_key = $1 WHERE phone = $2`, [key, phone]);
            }
          }
        } else {
          // Update crm_id if missing
          if (!existing.rows[0].crm_id) {
            await query(`UPDATE customers SET crm_id = $1, updated_at = NOW() WHERE phone = $2`, [person.id, phone]);
          }
        }
      } catch (err) { stats.errors.push({ phase: 'crmToLocal', phone, error: err.message }); }
    }
  } catch (err) { stats.errors.push({ phase: 'crmToLocal', error: err.message }); }

  // ── Phase 4: MANAGER → LOCAL (+ push new ones to CRM) ────────────────────
  try {
    const managerCustomers = await fetchAllManagerCustomers();
    for (const mc of managerCustomers) {
      // Manager.io customer list: try multiple phone field patterns
      const rawPhone =
        mc.phone || mc.Phone ||
        mc.customFields?.find?.(f => /phone/i.test(f.CustomField || f.key))?.Value ||
        mc.CustomFields?.find?.(f => /phone/i.test(f.CustomField || f.key))?.Value;

      if (!rawPhone) continue;
      const phone = normalizePhone(rawPhone);
      if (!phone || phone.length < 9) continue;
      const name  = mc.name || mc.Name || phone;
      const key   = mc.key;

      try {
        const existing = await query(`SELECT id, crm_id FROM customers WHERE phone = $1`, [phone]);
        if (existing.rows.length === 0) {
          // New customer from Manager.io — create locally
          const ins = await query(
            `INSERT INTO customers (phone, name, manager_key, source, consent_status, created_at, updated_at)
             VALUES ($1, $2, $3, 'manager_import', 'given', NOW(), NOW())
             ON CONFLICT (phone) DO UPDATE SET manager_key = EXCLUDED.manager_key, updated_at = NOW()
             RETURNING id, crm_id`,
            [phone, name, key]
          );
          stats.managerToLocal++;

          // Also push to CRM if not already there
          if (!ins.rows[0]?.crm_id) {
            const crmId = await crm.upsertPerson({ phone, name }).catch(() => null);
            if (crmId) {
              await query(`UPDATE customers SET crm_id = $1 WHERE phone = $2`, [crmId, phone]);
            }
          }
        } else {
          // Update manager_key if missing
          if (!existing.rows[0].manager_key && key) {
            await query(`UPDATE customers SET manager_key = $1, updated_at = NOW() WHERE phone = $2`, [key, phone]);
          }
        }
      } catch (err) { stats.errors.push({ phase: 'managerToLocal', phone, error: err.message }); }
    }
  } catch (err) { stats.errors.push({ phase: 'managerToLocal', error: err.message }); }

  stats.completedAt = new Date().toISOString();
  stats.durationMs  = Date.now() - new Date(stats.startedAt).getTime();

  // Persist last-run stats
  try {
    await cfgStore.set('sync_last_run',   stats.completedAt);
    await cfgStore.set('sync_last_stats', JSON.stringify(stats));
  } catch (_) {}

  logger.info('Bidirectional sync: complete', {
    localToCrm:     stats.localToCrm,
    localToManager: stats.localToManager,
    crmToLocal:     stats.crmToLocal,
    managerToLocal: stats.managerToLocal,
    errors:         stats.errors.length,
    durationMs:     stats.durationMs,
  });

  return stats;
};

// ── Auto-sync worker ──────────────────────────────────────────────────────────

let _intervalHandle = null;

/**
 * Start (or restart) the auto-sync background worker.
 * Reads sync_interval_min from config-store. Call again after config changes.
 */
const startWorker = async () => {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }

  const enabled  = await cfgStore.get('sync_enabled',      'false');
  const minutes  = parseInt(await cfgStore.get('sync_interval_min', '0'), 10);

  if (enabled !== 'true' || !minutes || minutes < 5) {
    logger.info('Sync worker: disabled or interval too short', { enabled, minutes });
    return;
  }

  const ms = minutes * 60 * 1000;
  logger.info('Sync worker: started', { intervalMin: minutes });

  _intervalHandle = setInterval(async () => {
    try { await runSync(); }
    catch (err) { logger.error('Sync worker: run failed', { error: err.message }); }
  }, ms);
};

module.exports = { runSync, startWorker };
