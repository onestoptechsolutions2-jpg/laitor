'use strict';

/**
 * @module config-store
 * @description Database-backed configuration store for bot messages and settings.
 *
 * WHY THIS EXISTS:
 *   Hardcoded strings mean every content change requires a code deploy.
 *   This module lets admins edit all bot messages, menu items, and response
 *   templates directly from the admin dashboard — no code change needed.
 *
 * HOW IT WORKS:
 *   1. On first read, loads from the `bot_config` table (DB)
 *   2. Caches in memory for CACHE_TTL_MS (5 min) — fast path for every message
 *   3. Falls back to DEFAULTS if a key is missing (safe on fresh install)
 *   4. On write (admin update), saves to DB and clears memory cache
 *
 * USAGE:
 *   const cfg = require('./config-store');
 *   const text = await cfg.get('welcome_message');
 *   await cfg.set('welcome_message', 'Hello from Laitor!');
 */

const { query } = require('../models/db');
const logger    = require('../utils/logger');

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Default values ────────────────────────────────────────────────────────────
// Safe fallbacks — used when DB has no entry for a key.
// These are also seeded into DB on first install via seedDefaults().

const DEFAULTS = {
  // ── Welcome & consent ──
  welcome_message:
    '👋 Hello! Welcome to *Laitor Invest* — your trusted internet & technology partner in Kenya.\n\nHow can we help you today?',
  consent_title:  'Permission to Contact You',
  consent_body:
    'We would like to send you information about our internet packages, products, and promotions via WhatsApp.\n\nYou can opt out at any time by replying *STOP*.',
  consent_footer: 'Laitor Invest · Privacy First',

  // ── KYC prompts ──
  kyc_name_prompt:
    '👋 Hello! To serve you better, could you tell us your *full name*?\n\n_(e.g. Jane Wanjiku)_',
  kyc_location_prompt:
    'Which *area or estate* are you located in?\n\n_(e.g. Westlands, Kilimani, Mombasa Road)_',

  // ── Main menu ──
  main_menu_title:  '🌐 Laitor Invest',
  main_menu_body:   'Welcome! How can we help you today?',
  main_menu_button: 'View Options',

  // ── Support ──
  support_prompt:
    '🔧 *Technical Support*\n\nPlease describe the issue you are experiencing and we will assign a technician.\n\n_e.g. "My internet is down" or "Router not connecting"_',

  // ── Agent handoff ──
  agent_handoff_message:
    '👤 *Speak to an Agent*\n\nOne of our team members will reach out to you shortly during business hours.\n\n⏰ *Mon–Fri: 8am–6pm · Sat: 9am–1pm*\n\nYou can also reach us:\n📞 *{business_phone}*\n📧 *{business_email}*',

  // ── Order / ticket templates ({placeholders} replaced at runtime) ──
  order_confirmed_template:
    '✅ Order confirmed for: *{product}*\n\nOur team will reach out to arrange delivery or installation.\n\nRef: *#{orderId}*',
  ticket_logged_template:
    '✅ Support ticket *#{ticketId}* logged.\n\nOur technical team will reach out to you shortly.\n\nThank you for your patience.',

  // ── Quote messages ──
  quote_approved_message:
    '✅ *Quote Approved!*\n\nThank you for confirming. Your invoice has been issued.\nInvoice Ref: *{invoiceRef}*\n\nOur team will follow up with next steps.',
  quote_declined_message:
    'Understood — quote declined. Our team will reach out if you have any questions.\n\nFeel free to browse our services again.',

  // ── Opt-out ──
  opt_out_message:
    '✅ You have been removed from our contact list.\n\nReply *START* or *MENU* at any time to reconnect.\n\nThank you — Laitor Team.',

  // ── Business info (used in templates) ──
  business_name:   'Laitor Invest Limited',
  business_phone:  '0700 000 000',
  business_email:  'support@laitor.co.ke',
  business_hours:  'Mon–Fri 8am–6pm · Sat 9am–1pm',

  // ── Bidirectional sync ──
  sync_enabled:       'false',   // 'true' | 'false'
  sync_interval_min:  '0',       // 0 = manual only; 15 | 30 | 60 | 360 | 1440
  sync_last_run:      '',        // ISO timestamp, updated after each run
  sync_last_stats:    '',        // JSON string of last run stats
};

// ── In-memory cache ───────────────────────────────────────────────────────────

let _cache     = null;
let _cacheTime = 0;

const isCacheValid = () => _cache && (Date.now() - _cacheTime) < CACHE_TTL_MS;
const clearCache   = () => { _cache = null; _cacheTime = 0; };

// ── DB helpers ────────────────────────────────────────────────────────────────

const loadFromDB = async () => {
  try {
    const res = await query(`SELECT key, value FROM bot_config`);
    const map = {};
    for (const row of res.rows) map[row.key] = row.value;
    return map;
  } catch (err) {
    logger.warn('config-store: DB load failed (using defaults)', { error: err.message });
    return {};
  }
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get all config values (defaults merged with DB overrides).
 * @returns {Promise<object>}
 */
const getAll = async () => {
  if (!isCacheValid()) {
    const fromDB = await loadFromDB();
    _cache     = { ...DEFAULTS, ...fromDB };
    _cacheTime = Date.now();
  }
  return _cache;
};

/**
 * Get a single config value. Returns default if not set in DB.
 * @param {string} key
 * @param {string} [fallback]
 * @returns {Promise<string>}
 */
const get = async (key, fallback) => {
  const all = await getAll();
  return all[key] ?? fallback ?? DEFAULTS[key] ?? '';
};

/**
 * Fill {placeholder} tokens in a template string.
 * @param {string} template
 * @param {object} vars  - e.g. { product: 'Fibre 10Mbps', orderId: '42' }
 * @returns {string}
 */
const fill = (template, vars = {}) =>
  template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);

/**
 * Save a config value to DB and clear cache.
 * @param {string} key
 * @param {string} value
 */
const set = async (key, value) => {
  await query(
    `INSERT INTO bot_config (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, String(value)]
  );
  clearCache();
  logger.info('config-store: updated', { key });
};

/**
 * Save multiple values at once.
 * @param {object} map
 */
const setMany = async (map) => {
  for (const [k, v] of Object.entries(map)) await set(k, v);
};

/**
 * Reset one key to its built-in default.
 * @param {string} key
 */
const resetToDefault = async (key) => {
  if (DEFAULTS[key] !== undefined) await set(key, DEFAULTS[key]);
};

/**
 * Seed all default values into DB (INSERT ... ON CONFLICT DO NOTHING).
 * Safe to call on every startup — existing customised values are preserved.
 */
const seedDefaults = async () => {
  try {
    for (const [key, value] of Object.entries(DEFAULTS)) {
      await query(
        `INSERT INTO bot_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
        [key, value]
      );
    }
    logger.info('config-store: defaults seeded', { count: Object.keys(DEFAULTS).length });
  } catch (err) {
    logger.warn('config-store: seed failed (non-fatal)', { error: err.message });
  }
};

module.exports = { get, getAll, set, setMany, resetToDefault, seedDefaults, fill, DEFAULTS };
