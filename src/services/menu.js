'use strict';

/**
 * @module menu
 * @description WhatsApp message and menu builder.
 *
 * All text content is loaded from config-store (DB-backed, admin-editable).
 * Hardcoded strings are gone — admins update content via the dashboard
 * without touching code or redeploying.
 *
 * WHY ASYNC BUILDERS:
 *   Each builder calls config-store.get() which hits an in-memory cache
 *   (5-min TTL). First call after cache miss hits DB once, then all
 *   subsequent calls in that window are sub-millisecond.
 *
 * MESSAGE TYPES returned:
 *   { type: 'text',    text: '...' }
 *   { type: 'buttons', title, body, footer, buttons: [{id, label}] }
 *   { type: 'list',    title, body, buttonText, sections: [{title, rows}] }
 */

const { query }  = require('../models/db');
const cfg        = require('./config-store');
const logger     = require('../utils/logger');

// ── Consent message ───────────────────────────────────────────────────────────

/**
 * Build the consent request message (sent to imported contacts).
 * Returns interactive buttons: Yes I accept / No opt out.
 * @returns {Promise<object[]>}
 */
const buildConsentMessage = async () => {
  const [title, body, footer] = await Promise.all([
    cfg.get('consent_title'),
    cfg.get('consent_body'),
    cfg.get('consent_footer'),
  ]);
  return [{
    type:    'buttons',
    title,
    body,
    footer,
    buttons: [
      { id: '1', label: '✅ Yes, I accept' },
      { id: '2', label: '❌ No, opt out'   },
    ],
  }];
};

// ── Main menu ─────────────────────────────────────────────────────────────────

/**
 * Load active menu items from DB, ordered by display_order.
 * Falls back to 4 hardcoded rows if table is empty.
 * @returns {Promise<Array<{id,label,description,icon,action,display_order}>>}
 */
const loadMenuItems = async () => {
  try {
    const res = await query(
      `SELECT * FROM menu_items WHERE active = true ORDER BY display_order, id`
    );
    if (res.rows.length > 0) return res.rows;
  } catch (err) {
    logger.warn('menu: loadMenuItems DB failed', { error: err.message });
  }
  // Fallback — should only happen before migration runs
  return [
    { id: 1, label: 'Internet Packages',    description: 'Browse our internet plans',      icon: '📶', action: 'INTERNET_BROWSE', display_order: 1 },
    { id: 2, label: 'Products & Equipment', description: 'CCTV, routers, networking gear', icon: '📦', action: 'PRODUCT_BROWSE',  display_order: 2 },
    { id: 3, label: 'Technical Support',    description: 'Report an issue or fault',       icon: '🔧', action: 'SUPPORT_AWAIT',   display_order: 3 },
    { id: 4, label: 'Speak to an Agent',    description: 'Get help from our team',         icon: '👤', action: 'AGENT_HANDOFF',   display_order: 4 },
  ];
};

/**
 * Build the main menu as an interactive list message.
 * @returns {Promise<object[]>}
 */
const buildMainMenu = async () => {
  const [title, body, buttonText, items] = await Promise.all([
    cfg.get('main_menu_title'),
    cfg.get('main_menu_body'),
    cfg.get('main_menu_button'),
    loadMenuItems(),
  ]);

  return [{
    type:       'list',
    title,
    body,
    buttonText,
    sections:   [{
      title: 'Main Menu',
      rows:  items.map((item, i) => ({
        id:          String(i + 1),
        title:       `${item.icon} ${item.label}`,
        description: item.description || '',
      })),
    }],
  }];
};

/**
 * Get the action (state) for a menu choice number.
 * Returns null if choice is out of range.
 * @param {string|number} choice
 * @returns {Promise<string|null>}
 */
const getMenuAction = async (choice) => {
  const items = await loadMenuItems();
  const idx   = parseInt(choice, 10) - 1;
  return items[idx]?.action || null;
};

// ── Support & handoff ─────────────────────────────────────────────────────────

/** @returns {Promise<object[]>} */
const buildSupportPrompt = async () => [{
  type: 'text',
  text: await cfg.get('support_prompt'),
}];

/** @returns {Promise<object[]>} */
const buildAgentHandoff = async () => [{
  type: 'text',
  text: cfg.fill(await cfg.get('agent_handoff_message'), {
    business_phone: await cfg.get('business_phone'),
    business_email: await cfg.get('business_email'),
    business_hours: await cfg.get('business_hours'),
  }),
}];

/** @returns {Promise<object[]>} */
const buildOptOutConfirm = async () => [{
  type: 'text',
  text: await cfg.get('opt_out_message'),
}];

// ── Catalog menus ─────────────────────────────────────────────────────────────

/**
 * Build the internet packages list.
 * @param {Array} items - Catalog items of type 'internet'
 * @returns {object[]}
 */
const buildInternetMenu = (items) => {
  if (!items || items.length === 0) {
    return [{ type: 'text', text: '📶 *Internet Packages*\n\nNo packages available yet. Please contact our team.\n\nType *MENU* to go back.' }];
  }
  const lines = items.map((item, i) =>
    `*${i + 1}.* ${item.name}${item.price ? ' — KES ' + Number(item.price).toLocaleString() : ''}${item.description ? '\n    _' + item.description + '_' : ''}`
  ).join('\n\n');
  return [{
    type: 'text',
    text: `📶 *Internet Packages*\n\n${lines}\n\n_Reply with a number to select, or 0 to go back._`,
  }];
};

/**
 * Build the products & equipment list.
 * @param {Array} items
 * @returns {object[]}
 */
const buildProductMenu = (items) => {
  if (!items || items.length === 0) {
    return [{ type: 'text', text: '📦 *Products & Equipment*\n\nNo products available yet. Please contact our team.\n\nType *MENU* to go back.' }];
  }
  const lines = items.map((item, i) =>
    `*${i + 1}.* ${item.name}${item.price ? ' — KES ' + Number(item.price).toLocaleString() : ''}${item.description ? '\n    _' + item.description + '_' : ''}`
  ).join('\n\n');
  return [{
    type: 'text',
    text: `📦 *Products & Equipment*\n\n${lines}\n\n_Reply with a number to select, or 0 to go back._`,
  }];
};

/**
 * Build the order confirmation message with Confirm/Cancel buttons.
 * @param {string} name  - Item name
 * @param {number} price
 * @returns {object[]}
 */
const buildConfirmMenu = (name, price) => [{
  type:    'buttons',
  title:   '🛒 Confirm Order',
  body:    `*${name}*${price ? '\nPrice: KES ' + Number(price).toLocaleString() : ''}\n\nWould you like to proceed with this order?`,
  footer:  'Laitor Invest',
  buttons: [
    { id: '1', label: '✅ Confirm Order' },
    { id: '2', label: '❌ Cancel'        },
  ],
}];

// ── Template rendering ────────────────────────────────────────────────────────

/** Render order confirmed message */
const buildOrderConfirmed = async (vars) => {
  const template = await cfg.get('order_confirmed_template');
  return cfg.fill(template, vars);
};

/** Render ticket logged message */
const buildTicketLogged = async (vars) => {
  const template = await cfg.get('ticket_logged_template');
  return cfg.fill(template, vars);
};

/** Render quote approved message */
const buildQuoteApproved = async (vars) => {
  const template = await cfg.get('quote_approved_message');
  return cfg.fill(template, vars);
};

/** Render quote declined message */
const buildQuoteDeclined = async () =>
  cfg.get('quote_declined_message');

// ── Backwards-compat sync exports (used in some places) ──────────────────────
// These are pre-built at module load time for the FIRST call and refreshed after.
// Async callers should use the build* functions directly.

const SUPPORT_PROMPT = [{ type: 'text', text: '🔧 *Technical Support*\n\nPlease describe your issue and our team will assist you.' }];
const AGENT_HANDOFF  = [{ type: 'text', text: '👤 *Speak to an Agent*\n\nA team member will reach out shortly.' }];
const OPT_OUT_CONFIRM = [{ type: 'text', text: '✅ You have been removed from our contact list. Reply MENU to reconnect.' }];

// CONSENT_MESSAGE and MAIN_MENU are now async — callers must await buildConsentMessage() / buildMainMenu()
// For backwards compat with any sync callers, these point to the sync fallbacks:
const CONSENT_MESSAGE = [{
  type:    'buttons',
  title:   'Permission to Contact You',
  body:    'We would like to send you information about our services via WhatsApp. You can opt out at any time by replying STOP.',
  footer:  'Laitor Invest',
  buttons: [{ id: '1', label: '✅ Yes, I accept' }, { id: '2', label: '❌ No, opt out' }],
}];

const MAIN_MENU = [{
  type:       'list',
  title:      '🌐 Laitor Invest',
  body:       'Welcome! How can we help you today?',
  buttonText: 'View Options',
  sections:   [{ title: 'Main Menu', rows: [
    { id: '1', title: '📶 Internet Packages',    description: 'Browse our internet plans' },
    { id: '2', title: '📦 Products & Equipment', description: 'CCTV, routers, networking gear' },
    { id: '3', title: '🔧 Technical Support',    description: 'Report an issue or fault' },
    { id: '4', title: '👤 Speak to an Agent',    description: 'Get help from our team' },
  ]}],
}];

module.exports = {
  // Async builders (preferred)
  buildConsentMessage,
  buildMainMenu,
  buildSupportPrompt,
  buildAgentHandoff,
  buildOptOutConfirm,
  buildInternetMenu,
  buildProductMenu,
  buildConfirmMenu,
  buildOrderConfirmed,
  buildTicketLogged,
  buildQuoteApproved,
  buildQuoteDeclined,
  getMenuAction,
  loadMenuItems,
  // Sync compat exports
  CONSENT_MESSAGE,
  MAIN_MENU,
  SUPPORT_PROMPT,
  AGENT_HANDOFF,
  OPT_OUT_CONFIRM,
};
