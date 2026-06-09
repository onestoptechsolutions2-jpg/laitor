'use strict';

/**
 * @module orchestrator
 * @description Central message processing engine for the Laitor WhatsApp bot.
 *
 * Every inbound WhatsApp message flows through this module.
 * It maintains a per-customer state machine (stored in Redis) and routes
 * each message to the correct handler based on the current state.
 *
 * State machine overview:
 *
 *   (new import contact)
 *       → CONSENT_PENDING  → KYC_NAME → KYC_LOCATION → MAIN_MENU
 *
 *   (inbound / non-import contact)
 *       → KYC_NAME / KYC_LOCATION (if fields missing) → MAIN_MENU
 *
 *   MAIN_MENU
 *       → INTERNET_BROWSE  → INTERNET_CONFIRM  → (order created) → MAIN_MENU
 *       → PRODUCT_BROWSE   → PRODUCT_CONFIRM   → (order created) → MAIN_MENU
 *       → SUPPORT_AWAIT    → (ticket created)  → MAIN_MENU
 *       → AGENT_HANDOFF    (human takeover — no auto-reply)
 *
 *   QUOTE_PENDING   (set when a quote WhatsApp message is sent to the customer)
 *       → tap QUOTE_APPROVE → invoice created → MAIN_MENU
 *       → tap QUOTE_DECLINE → CRM LOST → MAIN_MENU
 *
 * Consent rules:
 *   - source='import' contacts: must explicitly accept before any menu is shown
 *   - source='inbound' contacts: consent is implicit (they messaged us first)
 *   - STOP keyword: opt-out at any time, from any state
 *
 * Admin commands (admin phone only):
 *   TICKET#<id> RESOLVED [technician name]
 *   ORDER#<id> CONFIRMED | PROCESSING | FULFILLED | CANCELLED
 */

const { query }     = require('../models/db');
const session       = require('../services/session');
const whatsapp      = require('../services/whatsapp');
const crm           = require('../services/crm');
const consent       = require('../services/consent');
const catalog       = require('../services/catalog');
const menu          = require('../services/menu');
const orderService  = require('../services/order');
const ticketService = require('../services/ticket');
const agentSvc      = require('../services/agents');
const quoteSvc      = require('../services/quote');
const manager       = require('../services/manager');
const logger        = require('../utils/logger');

// ── Marketplace
const mktCatalog  = require('../services/marketplace/catalog');
const mktCart     = require('../services/marketplace/cart');
const mktCheckout = require('../services/marketplace/checkout');
const mktPayment  = require('../services/marketplace/payment');

// ─── State constants ──────────────────────────────────────────────────────────

const STATES = {
  CONSENT_PENDING:  'CONSENT_PENDING',
  KYC_NAME:         'KYC_NAME',
  KYC_LOCATION:     'KYC_LOCATION',
  MAIN_MENU:        'MAIN_MENU',
  INTERNET_BROWSE:  'INTERNET_BROWSE',
  PRODUCT_BROWSE:   'PRODUCT_BROWSE',
  INTERNET_CONFIRM: 'INTERNET_CONFIRM',
  PRODUCT_CONFIRM:  'PRODUCT_CONFIRM',
  SUPPORT_AWAIT:    'SUPPORT_AWAIT',
  AGENT_HANDOFF:    'AGENT_HANDOFF',
  QUOTE_PENDING:       'QUOTE_PENDING',
  // ── Marketplace states
  SHOPPING_MAIN:       'SHOPPING_MAIN',
  SHOPPING_CATEGORY:   'SHOPPING_CATEGORY',
  SHOPPING_PRODUCT:    'SHOPPING_PRODUCT',
  SHOPPING_CART:       'SHOPPING_CART',
  CHECKOUT_ADDRESS:    'CHECKOUT_ADDRESS',
  CHECKOUT_PAYMENT:    'CHECKOUT_PAYMENT',
  CHECKOUT_MPESA:      'CHECKOUT_MPESA',
};

// ─── Utility helpers ──────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Persist a message to the messages audit log.
 * Uses ON CONFLICT DO NOTHING on msg_id to prevent duplicate log entries
 * if the same webhook fires twice (Evolution API can retry).
 */
const logMessage = async ({ phone, direction, text, raw, msgId }) => {
  try {
    await query(
      `INSERT INTO messages (phone, direction, text, raw, msg_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (msg_id) DO NOTHING`,
      [phone, direction, text, JSON.stringify(raw), msgId]
    );
  } catch (err) {
    logger.warn('Message log failed', { error: err.message });
  }
};

/**
 * Push customer+lead to Twenty CRM (non-fatal).
 * Called after any intent is detected.
 *
 * @param {object} params - { phone, name, type, notes }
 * @returns {Promise<string|null>} CRM person ID
 */
const syncToCRM = async ({ phone, name, type, notes }) => {
  try {
    const crmPersonId = await crm.upsertPerson({ phone, name });
    if (!crmPersonId) return null;
    await crm.createLead({ crmPersonId, type, notes });
    await crm.logActivity({ crmPersonId, message: notes || type, direction: 'in' });
    return crmPersonId;
  } catch (err) {
    logger.warn('CRM sync failed (non-fatal)', { error: err.message });
    return null;
  }
};

/**
 * Determine the first missing KYC field for a customer.
 * Called after consent is given to progressively collect name and location.
 *
 * @param {object} customer - DB row with name, location fields
 * @returns {'name' | 'location' | null}
 */
const nextKYCField = (customer) => {
  const name = customer.name;
  if (!name || name === 'Unknown' || name.trim() === '') return 'name';
  if (!customer.location) return 'location';
  return null;
};

// ─── KYC handlers ─────────────────────────────────────────────────────────────

/**
 * Handle the KYC_NAME state — customer is asked for their name.
 * On receipt, saves to DB + CRM, checks if location is also needed.
 */
const handleKYCName = async ({ text, customer, phone }) => {
  const name = text.trim();
  if (name.length < 2) {
    return {
      nextState: STATES.KYC_NAME,
      replies:   [{ type: 'text', text: 'Please enter your full name (e.g. *John Kamau*).' }],
    };
  }

  await query(`UPDATE customers SET name = $1 WHERE phone = $2`, [name, phone]);
  const crmPersonId = await crm.upsertPerson({ phone, name });
  if (crmPersonId) await crm.updatePerson(crmPersonId, { name });

  const updatedCustomer = { ...customer, name };
  const nextField       = nextKYCField(updatedCustomer);

  if (nextField === 'location') {
    return {
      nextState: STATES.KYC_LOCATION,
      replies: [{ type: 'text', text: `Thanks ${name}! 👋\n\nOne more thing — which area or estate are you in? (e.g. *Westlands*, *Kilimani*, *Mombasa Road*)` }],
    };
  }
  return {
    nextState: STATES.MAIN_MENU,
    replies:   [{ type: 'text', text: `Thanks ${name}! You're all set. 🎉` }, ...(await menu.buildMainMenu())],
  };
};

/**
 * Handle the KYC_LOCATION state — customer is asked for their area.
 * On receipt, saves to DB + CRM, shows main menu.
 */
const handleKYCLocation = async ({ text, customer, phone }) => {
  const location = text.trim();
  if (location.length < 2) {
    return {
      nextState: STATES.KYC_LOCATION,
      replies:   [{ type: 'text', text: 'Please enter your area or estate name.' }],
    };
  }

  await query(`UPDATE customers SET location = $1 WHERE phone = $2`, [location, phone]);
  const crmPersonId = await crm.findPersonByPhone(phone).then((p) => p?.id).catch(() => null);
  if (crmPersonId) await crm.updatePerson(crmPersonId, { location });

  const name = customer.name || 'there';
  return {
    nextState: STATES.MAIN_MENU,
    replies: [
      { type: 'text', text: `Got it — *${location}*. We now have your full details on file. 📋` },
      ...(await menu.buildMainMenu()),
    ],
  };
};

// ─── Admin command handler ────────────────────────────────────────────────────

/**
 * Parse an admin command from a WhatsApp message.
 * Format: TICKET#42 RESOLVED John  /  ORDER#7 CONFIRMED
 * Returns null if the message is not a valid admin command.
 *
 * @param {string} text
 * @returns {{type, id, action, extra}|null}
 */
const parseAdminCommand = (text) => {
  const match = text.trim().match(/^(TICKET|ORDER)#(\d+)\s+(\w+)(?:\s+(.+))?$/i);
  if (!match) return null;
  return { type: match[1].toUpperCase(), id: parseInt(match[2], 10), action: match[3].toUpperCase(), extra: match[4] || null };
};

const handleAdminCommand = async ({ cmd, phone }) => {
  const adminPhones = (process.env.ADMIN_PHONES || '').split(',').map((p) => p.trim());
  if (!adminPhones.includes(phone)) return null;
  let reply = null;

  if (cmd.type === 'TICKET') {
    const statusMap = {
      RESOLVED:    ticketService.TICKET_STATUS.RESOLVED,
      CLOSED:      ticketService.TICKET_STATUS.CLOSED,
      IN_PROGRESS: ticketService.TICKET_STATUS.IN_PROGRESS,
      ASSIGNED:    ticketService.TICKET_STATUS.IN_PROGRESS,
    };
    const status = statusMap[cmd.action];
    if (status) {
      const ticket = await ticketService.updateStatus(cmd.id, status, cmd.extra);
      if (ticket) {
        await whatsapp.sendText(ticket.phone,
          `Update on your support ticket *#${ticket.id}*:\n` +
          `Status: ${status.replace('_', ' ')}` +
          (cmd.extra ? `\nTechnician: ${cmd.extra}` : '') +
          '\n\nThank you for your patience. — Laitor Support'
        );
        reply = `Ticket #${cmd.id} → ${status}`;
      } else { reply = `Ticket #${cmd.id} not found`; }
    }
  }

  if (cmd.type === 'ORDER') {
    const statusMap = {
      CONFIRMED:  orderService.ORDER_STATUS.CONFIRMED,
      PROCESSING: orderService.ORDER_STATUS.PROCESSING,
      FULFILLED:  orderService.ORDER_STATUS.FULFILLED,
      CANCELLED:  orderService.ORDER_STATUS.CANCELLED,
    };
    const status = statusMap[cmd.action];
    if (status) {
      const order = await orderService.updateStatus(cmd.id, status);
      if (order) {
        if (status === orderService.ORDER_STATUS.CONFIRMED) {
          const customerKey = await manager.upsertCustomer({ phone: order.phone, name: order.phone });
          const invoiceRef  = await manager.createInvoice({ customerKey, orderId: order.id, product: order.product, phone: order.phone });
          if (invoiceRef) {
            await agentSvc.notifyNewInvoice({ phone: order.phone, name: order.name || order.phone, invoiceRef });
          }
        }
        await whatsapp.sendText(order.phone,
          `Update on your order *#${order.id}*:\n` +
          `Product: ${order.product}\n` +
          `Status: ${status.toUpperCase()}\n\n` +
          `Thank you for choosing Laitor! — Laitor Team`
        );
        reply = `Order #${cmd.id} → ${status}`;
      } else { reply = `Order #${cmd.id} not found`; }
    }
  }
  return reply;
};

// ─── Menu handlers ────────────────────────────────────────────────────────────

/** Main menu — routes to internet, products, support, or agent handoff */
const handleMainMenu = async ({ text }) => {
  const choice = text.trim().replace(/[^0-9]/g, '');
  if (!choice) return { nextState: STATES.MAIN_MENU, replies: await menu.buildMainMenu() };

  // Use action from DB so admin reordering menu items doesn't break routing
  const action = await menu.getMenuAction(choice);

  if (action === 'INTERNET_BROWSE') {
    const cat      = await catalog.getCatalog();
    const internet = catalog.splitByType(cat).internet;
    return { nextState: STATES.INTERNET_BROWSE, replies: menu.buildInternetMenu(internet), sessionData: { catalogInternet: internet } };
  }
  if (action === 'PRODUCT_BROWSE') {
    const cat      = await catalog.getCatalog();
    const products = catalog.splitByType(cat).products;
    return { nextState: STATES.PRODUCT_BROWSE, replies: menu.buildProductMenu(products), sessionData: { catalogProducts: products } };
  }
  if (action === 'SUPPORT_AWAIT')  return { nextState: STATES.SUPPORT_AWAIT, replies: await menu.buildSupportPrompt() };
  if (action === 'AGENT_HANDOFF')  return { nextState: STATES.AGENT_HANDOFF, replies: await menu.buildAgentHandoff() };

  // Unknown action or out-of-range choice — redisplay menu
  return { nextState: STATES.MAIN_MENU, replies: await menu.buildMainMenu() };
};

const handleInternetBrowse = async ({ text, sess }) => {
  const choice = parseInt(text.trim(), 10);
  if (choice === 0 || /^menu$/i.test(text.trim())) return { nextState: STATES.MAIN_MENU, replies: await menu.buildMainMenu() };
  let items = sess.catalogInternet;
  if (!items) { const cat = await catalog.getCatalog(); items = catalog.splitByType(cat).internet; }
  const selected = catalog.getByIndex(items, choice);
  if (!selected) return { nextState: STATES.INTERNET_BROWSE, replies: [{ type: 'text', text: `Please pick a number 1–${items.length}, or 0 to go back.` }], sessionData: { catalogInternet: items } };
  return { nextState: STATES.INTERNET_CONFIRM, replies: menu.buildConfirmMenu(selected.name, selected.price), sessionData: { pendingItem: selected, catalogInternet: items } };
};

const handleProductBrowse = async ({ text, sess }) => {
  const choice = parseInt(text.trim(), 10);
  if (choice === 0 || /^menu$/i.test(text.trim())) return { nextState: STATES.MAIN_MENU, replies: await menu.buildMainMenu() };
  let items = sess.catalogProducts;
  if (!items) { const cat = await catalog.getCatalog(); items = catalog.splitByType(cat).products; }
  const selected = catalog.getByIndex(items, choice);
  if (!selected) return { nextState: STATES.PRODUCT_BROWSE, replies: [{ type: 'text', text: `Please pick a number 1–${items.length}, or 0 to go back.` }], sessionData: { catalogProducts: items } };
  return { nextState: STATES.PRODUCT_CONFIRM, replies: menu.buildConfirmMenu(selected.name, selected.price), sessionData: { pendingItem: selected, catalogProducts: items } };
};

const handleConfirm = async ({ text, customer, phone, name, sess, orderType }) => {
  const choice = text.trim().replace(/[^0-9A-Z_]/gi, '').toUpperCase();

  if (choice === '2' || /^cancel$/i.test(text.trim())) {
    const items = orderType === 'internet' ? sess.catalogInternet : sess.catalogProducts;
    return { nextState: orderType === 'internet' ? STATES.INTERNET_BROWSE : STATES.PRODUCT_BROWSE, replies: orderType === 'internet' ? menu.buildInternetMenu(items || []) : menu.buildProductMenu(items || []) };
  }

  if (choice === '1') {
    const item = sess.pendingItem;
    if (!item) return { nextState: STATES.MAIN_MENU, replies: await menu.buildMainMenu() };

    let order = null;
    if (customer.id) order = await orderService.create({ customerId: customer.id, product: item.name, notes: item.name });

    await syncToCRM({ phone, name, type: orderType === 'internet' ? 'INTERNET_LEAD' : 'PRODUCT_ORDER', notes: item.name });

    // Notify category agent
    await agentSvc.notifyNewOrder({ phone, name, product: item.name, orderId: order?.id || '?', notes: `KES ${item.price || 'TBD'}` });

    const confirmText = await menu.buildOrderConfirmed({ product: item.name, orderId: String(order?.id || 'WA-' + Date.now()) });
    return {
      nextState: STATES.MAIN_MENU,
      replies: [
        { type: 'text', text: confirmText },
        ...(await menu.buildMainMenu()),
      ],
    };
  }

  return { nextState: orderType === 'internet' ? STATES.INTERNET_CONFIRM : STATES.PRODUCT_CONFIRM, replies: [{ type: 'text', text: 'Please tap *Confirm Order* or *Cancel*.' }] };
};

const handleSupportAwait = async ({ text, customer, phone, name }) => {
  let ticket = null;
  if (customer.id) ticket = await ticketService.create({ customerId: customer.id, issue: text });
  await syncToCRM({ phone, name, type: 'SUPPORT_REQUEST', notes: text });
  await agentSvc.notifyNewTicket({ phone, name, issue: text, ticketId: ticket?.id || '?', priority: ticket?.priority || 'medium' });
  const ticketText = await menu.buildTicketLogged({ ticketId: String(ticket?.id || '?') });
  return {
    nextState: STATES.MAIN_MENU,
    replies: [
      { type: 'text', text: ticketText },
      ...(await menu.buildMainMenu()),
    ],
  };
};

// ─── Quote approval handler ───────────────────────────────────────────────────

/**
 * Handle QUOTE_PENDING state.
 * Listens for the QUOTE_APPROVE or QUOTE_DECLINE button tap from the customer.
 * Button IDs are sent as the message text by Evolution API.
 *
 * On approval:
 *   1. Convert quote → invoice in Manager.io
 *   2. Advance CRM to WON
 *   3. Notify finance agent
 *   4. Send invoice confirmation to customer
 *
 * On decline:
 *   1. CRM → LOST
 *   2. Notify sales agent
 *   3. Thank customer, return to main menu
 */
const handleQuotePending = async ({ text, customer, phone, sess }) => {
  const tap = text.trim().toUpperCase();

  if (tap === 'QUOTE_APPROVE' || tap === '1') {
    try {
      const quoteId = sess.pendingQuoteId;
      if (!quoteId) return { nextState: STATES.MAIN_MENU, replies: [{ type: 'text', text: 'Quote not found. Please contact our team.' }, ...(await menu.buildMainMenu())] };

      const { invoiceRef } = await quoteSvc.approve(quoteId, customer);

      return {
        nextState: STATES.MAIN_MENU,
        replies: [
          {
            type: 'text',
            text: [
              `✅ *Quote Approved!*`,
              ``,
              `Thank you for confirming. Your invoice has been issued.`,
              `Invoice Ref: *${invoiceRef}*`,
              ``,
              `Our team will follow up with next steps. — Laitor Team`,
            ].join('\n'),
          },
          ...(await menu.buildMainMenu()),
        ],
      };
    } catch (err) {
      logger.error('Quote approval error', { phone, error: err.message });
      return { nextState: STATES.MAIN_MENU, replies: [{ type: 'text', text: 'Sorry, we could not process your approval. Please contact our team directly.' }, ...(await menu.buildMainMenu())] };
    }
  }

  if (tap === 'QUOTE_DECLINE' || tap === '2') {
    try {
      const quoteId = sess.pendingQuoteId;
      if (quoteId) await quoteSvc.decline(quoteId, customer);
    } catch (err) {
      logger.warn('Quote decline error (non-fatal)', { phone, error: err.message });
    }
    return {
      nextState: STATES.MAIN_MENU,
      replies: [
        { type: 'text', text: `Understood — quote declined. Our team will reach out if you have any questions.\n\nFeel free to browse our services again.` },
        ...(await menu.buildMainMenu()),
      ],
    };
  }

  // Unrecognised response while quote is pending
  return {
    nextState: STATES.QUOTE_PENDING,
    replies: [{ type: 'text', text: 'Please tap *Approve Quote* or *Decline* to respond to your quote.' }],
  };
};

// ─── Main process ─────────────────────────────────────────────────────────────

/**
 * Process a single inbound WhatsApp message end-to-end.
 * Called by the webhook route for every inbound event.
 *
 * @param {object} msg - Normalised message: { phone, name, text, msgId, raw }
 */
const process = async (msg) => {
  const { phone, name, text, msgId, raw } = msg;
  logger.info('Orchestrator processing', { phone, msgId });

  await logMessage({ phone, direction: 'in', text, raw, msgId });

  // ── Admin commands bypass all state ────────────────────────────────────────
  const cmd = parseAdminCommand(text);
  if (cmd) {
    const adminReply = await handleAdminCommand({ cmd, phone });
    if (adminReply) { await whatsapp.sendText(phone, adminReply); return; }
  }

  // ── Global opt-out ─────────────────────────────────────────────────────────
  if (/^stop$/i.test(text.trim())) {
    await consent.denyConsent(phone);
    await query(`UPDATE customers SET consent_status = 'denied' WHERE phone = $1`, [phone]);
    await whatsapp.sendSequence(phone, await menu.buildOptOutConfirm());
    return;
  }

  const wantsMenu = /^(menu|hi|hello|hujambo|habari|start)$/i.test(text.trim());

  // ── Upsert customer ────────────────────────────────────────────────────────
  let customer = { id: null, phone };
  try {
    const existing = await query(`SELECT * FROM customers WHERE phone = $1`, [phone]);

    if (existing.rows.length > 0) {
      customer = existing.rows[0];
      // Non-import contacts that somehow still have pending consent → auto-give
      if (customer.source !== 'import' && customer.consent_status === 'pending') {
        await query(`UPDATE customers SET consent_status = 'given' WHERE phone = $1`, [phone]);
        customer.consent_status = 'given';
      }
    } else {
      const res = await query(
        `INSERT INTO customers (phone, name, source, consent_status)
         VALUES ($1, $2, 'inbound', 'given')
         ON CONFLICT (phone) DO UPDATE SET
           name = COALESCE(EXCLUDED.name, customers.name), updated_at = NOW()
         RETURNING *`,
        [phone, name || null]
      );
      customer = res.rows[0];
      // First contact ever — send welcome message before anything else
      if (!sess.welcomed) {
        const cfgStore = require('../services/config-store');
        const welcome  = await cfgStore.get('welcome_message').catch(() => null);
        if (welcome) await whatsapp.sendText(phone, welcome).catch(() => {});
      }
    }
  } catch (err) {
    logger.error('Customer upsert failed', { phone, error: err.message });
  }

  const consentStatus = customer.consent_status || 'pending';
  const sess          = await session.get(phone);

  // ── CONSENT GATE (imported contacts only) ──────────────────────────────────
  if (consentStatus !== 'given') {
    if (consentStatus === 'denied') {
      logger.info('Message from opted-out contact ignored', { phone });
      return;
    }

    if (!sess.consentSent) {
      await whatsapp.sendSequence(phone, await menu.buildConsentMessage());
      await session.set(phone, { ...sess, state: STATES.CONSENT_PENDING, consentSent: true, customerId: customer.id });
    } else {
      const consentReply = consent.parseConsentReply(text);
      if (consentReply === consent.CONSENT_STATUS.GIVEN) {
        await consent.giveConsent(phone);
        await query(`UPDATE customers SET consent_status = 'given', consented_at = NOW() WHERE phone = $1`, [phone]);
        const updatedCustomer = { ...customer, consent_status: 'given' };
        const nextField       = nextKYCField(updatedCustomer);
        if (nextField === 'name') {
          await whatsapp.sendText(phone, `Thank you for accepting! 🎉\n\nTo serve you better, what is your full name?`);
          await session.set(phone, { state: STATES.KYC_NAME, customerId: customer.id });
        } else if (nextField === 'location') {
          await whatsapp.sendText(phone, `Thank you! 🎉\n\nWhich area or estate are you in?`);
          await session.set(phone, { state: STATES.KYC_LOCATION, customerId: customer.id });
        } else {
          await whatsapp.sendSequence(phone, [{ type: 'text', text: 'Thank you! You are now connected to *Laitor Invest*. 🎉' }, ...(await menu.buildMainMenu())]);
          await session.set(phone, { state: STATES.MAIN_MENU, customerId: customer.id });
        }
      } else if (consentReply === consent.CONSENT_STATUS.DENIED) {
        await consent.denyConsent(phone);
        await query(`UPDATE customers SET consent_status = 'denied' WHERE phone = $1`, [phone]);
        await whatsapp.sendSequence(phone, await menu.buildOptOutConfirm());
      } else {
        await whatsapp.sendText(phone, 'Please tap *Yes, I accept* or *No, opt out*.');
        await session.set(phone, { ...sess, state: STATES.CONSENT_PENDING });
      }
    }
    return;
  }

  // ── CONSENTED — run state machine ──────────────────────────────────────────
  const currentState = sess.state || STATES.MAIN_MENU;

  // KYC check on first MAIN_MENU visit
  if (!sess.kycDone && !wantsMenu && currentState === STATES.MAIN_MENU) {
    const nextField = nextKYCField(customer);
    if (nextField === 'name') {
      await whatsapp.sendText(phone, `Hello! 👋 To serve you better, could you tell us your full name?`);
      await session.set(phone, { ...sess, state: STATES.KYC_NAME, customerId: customer.id });
      return;
    }
    if (nextField === 'location') {
      await whatsapp.sendText(phone, `Hi ${customer.name}! 👋 Which area or estate are you located in?`);
      await session.set(phone, { ...sess, state: STATES.KYC_LOCATION, customerId: customer.id });
      return;
    }
    await session.set(phone, { ...sess, kycDone: true });
  }

  let result;

  try {
    if (wantsMenu) {
      result = { nextState: STATES.MAIN_MENU, replies: await menu.buildMainMenu() };
    } else if (currentState === STATES.KYC_NAME) {
      result = await handleKYCName({ text, customer, phone });
    } else if (currentState === STATES.KYC_LOCATION) {
      result = await handleKYCLocation({ text, customer, phone });
    } else if (currentState === STATES.QUOTE_PENDING) {
      result = await handleQuotePending({ text, customer, phone, sess });
    } else if (currentState === STATES.MAIN_MENU) {
      // Intercept shop/cart intents before main menu handler
      const shopTriggers = ['shop','shopping','marketplace','buy','store','browse catalog','cart','my cart','checkout','track order'];
      const tLow = (text || '').toLowerCase().trim();
      if (tLow === 'shop' || tLow === 'shopping' || tLow === 'marketplace' || tLow === '🛍️ shop') {
        result = await handleShoppingMain();
      } else if (tLow === 'cart' || tLow === 'my cart' || tLow === '🛒' || tLow === 'view cart') {
        result = await handleShoppingCart({ customer, sess });
      } else {
        result = await handleMainMenu({ text });
      }
    } else if (currentState === STATES.INTERNET_BROWSE) {
      result = await handleInternetBrowse({ text, sess });
    } else if (currentState === STATES.PRODUCT_BROWSE) {
      result = await handleProductBrowse({ text, sess });
    } else if (currentState === STATES.INTERNET_CONFIRM) {
      result = await handleConfirm({ text, customer, phone, name, sess, orderType: 'internet' });
    } else if (currentState === STATES.PRODUCT_CONFIRM) {
      result = await handleConfirm({ text, customer, phone, name, sess, orderType: 'product' });
    } else if (currentState === STATES.SUPPORT_AWAIT) {
      result = await handleSupportAwait({ text, customer, phone, name });
    } else if (currentState === STATES.SHOPPING_MAIN) {
      result = await handleShoppingMain();
    } else if (currentState === STATES.SHOPPING_CATEGORY) {
      const t = (text || '').trim();
      if (t.startsWith('ADD_CART_')) {
        result = await handleAddToCart({ text, customer, sess });
      } else if (t.startsWith('PRD_')) {
        result = await handleShoppingProduct({ text, sess });
      } else {
        result = await handleShoppingCategory({ text, sess });
      }
    } else if (currentState === STATES.SHOPPING_PRODUCT) {
      const t = (text || '').trim();
      if (t.startsWith('ADD_CART_')) {
        result = await handleAddToCart({ text, customer, sess });
      } else if (t === 'CART_VIEW') {
        result = await handleShoppingCart({ customer, sess });
      } else if (t === 'SHOP_BACK' || t === 'SHOP_MENU') {
        result = sess.shopCategoryId
          ? await handleShoppingCategory({ text: `CAT_${sess.shopCategoryId}`, sess })
          : await handleShoppingMain();
      } else {
        result = await handleShoppingProduct({ text, sess });
      }
    } else if (currentState === STATES.SHOPPING_CART) {
      const t = (text || '').trim();
      if (t === 'CHECKOUT_START') {
        result = await handleCheckoutAddress({ text, customer, sess });
      } else if (t === 'CART_CLEAR') {
        await mktCart.clearCart(customer.id);
        result = { nextState: STATES.SHOPPING_MAIN, replies: [{ type: 'text', text: '🗑 Cart cleared.' }] };
      } else {
        result = await handleShoppingCart({ customer, sess });
      }
    } else if (currentState === STATES.CHECKOUT_ADDRESS) {
      result = await handleCheckoutAddress({ text, customer, sess });
    } else if (currentState === STATES.CHECKOUT_PAYMENT) {
      result = await handleCheckoutPayment({ text, customer, name, phone, sess });
    } else if (currentState === STATES.CHECKOUT_MPESA) {
      result = await handleCheckoutMpesa({ text, customer, sess });
    } else if (currentState === STATES.AGENT_HANDOFF) {
      logger.info('Message in agent handoff — not auto-replied', { phone });
      return;
    } else {
      result = { nextState: STATES.MAIN_MENU, replies: await menu.buildMainMenu() };
    }
  } catch (err) {
    logger.error('Orchestrator handler error', { phone, state: currentState, error: err.message, stack: err.stack });
    result = { nextState: STATES.MAIN_MENU, replies: [{ type: 'text', text: 'We encountered an issue. Type *MENU* to try again.' }, ...(await menu.buildMainMenu())] };
  }

  const newSess = {
    ...sess,
    state:       result.nextState,
    lastMessage: text,
    customerId:  customer.id,
    welcomed:    true,
    kycDone:     result.nextState !== STATES.KYC_NAME && result.nextState !== STATES.KYC_LOCATION
                 ? (sess.kycDone || result.nextState === STATES.MAIN_MENU)
                 : false,
    ...(result.sessionData || {}),
  };
  await session.set(phone, newSess);

  try {
    await whatsapp.sendSequence(phone, result.replies);
    for (const r of result.replies) {
      const textContent = typeof r === 'string' ? r : r.text || r.body || r.title || JSON.stringify(r);
      await logMessage({ phone, direction: 'out', text: textContent, raw: { automated: true }, msgId: 'out-' + msgId + '-' + Date.now() });
    }
  } catch (err) {
    logger.error('Failed to send WhatsApp reply', { phone, error: err.message });
  }

  logger.info('Orchestrator done', { phone, nextState: result.nextState });
};


// ═══════════════════════════════════════════════════════════════════
// MARKETPLACE HANDLERS
// ═══════════════════════════════════════════════════════════════════

/** Show category list */
const handleShoppingMain = async () => {
  const cats = await mktCatalog.getCategories();
  if (!cats.length) {
    return {
      nextState: STATES.MAIN_MENU,
      replies: [{ type: 'text', text: '🛍️ Our marketplace is being stocked. Check back soon!' }],
    };
  }
  const listPayload = mktCatalog.buildCategoryList(cats);
  return {
    nextState: STATES.SHOPPING_CATEGORY,
    sessionData: {},
    replies: [{ type: 'list', ...listPayload }],
  };
};

/** Browse products in a category or handle pagination */
const handleShoppingCategory = async ({ text, sess }) => {
  const t = (text || '').trim();

  // Navigation controls
  if (t === 'SHOP_MENU' || t.toLowerCase() === 'back') return handleShoppingMain();
  if (t === 'CART_VIEW')  return handleShoppingCart({ sess });

  // Pagination: PAGE_NEXT_2 / PAGE_PREV_1
  let page = parseInt(sess.shopPage || 1);
  let categoryId = sess.shopCategoryId;

  if (t.startsWith('PAGE_NEXT_')) { page = parseInt(t.split('_')[2]); }
  else if (t.startsWith('PAGE_PREV_')) { page = parseInt(t.split('_')[2]); }
  else if (t.startsWith('CAT_')) { categoryId = parseInt(t.split('_')[1]); page = 1; }
  else if (t.startsWith('PRD_')) {
    return handleShoppingProduct({ productId: parseInt(t.split('_')[1]), sess });
  }

  if (!categoryId) return handleShoppingMain();

  const cat = await mktCatalog.getCategory(categoryId);
  const { products, pages } = await mktCatalog.getProducts({ categoryId, page });

  if (!products.length) {
    return {
      nextState: STATES.SHOPPING_CATEGORY,
      sessionData: { shopCategoryId: categoryId, shopPage: page },
      replies: [{ type: 'text', text: `No products in ${cat?.name || 'this category'} yet. Reply *SHOP* to browse other categories.` }],
    };
  }

  const listPayload = mktCatalog.buildProductList(products, page, pages, cat?.name || 'Products');
  return {
    nextState: STATES.SHOPPING_CATEGORY,
    sessionData: { shopCategoryId: categoryId, shopPage: page },
    replies: [{ type: 'list', ...listPayload }],
  };
};

/** Show product detail */
const handleShoppingProduct = async ({ text, productId: pid, sess }) => {
  const t   = (text || '').trim();
  const id  = pid || (t.startsWith('PRD_') ? parseInt(t.split('_')[1]) : null) || sess.shopProductId;
  if (!id) return handleShoppingMain();

  const product = await mktCatalog.getProduct(id);
  if (!product) return { nextState: STATES.SHOPPING_CATEGORY, replies: [{ type: 'text', text: 'Product not found.' }] };

  const detail = mktCatalog.buildProductDetail(product);
  const replies = [];
  if (product.image_url) replies.push({ type: 'image', url: product.image_url, caption: detail.text });
  else replies.push({ type: 'text', text: detail.text });
  replies.push({ type: 'buttons', ...detail });

  return {
    nextState: STATES.SHOPPING_PRODUCT,
    sessionData: { shopProductId: id, shopCategoryId: product.category_id },
    replies,
  };
};

/** Add to cart from button tap */
const handleAddToCart = async ({ text, customer, sess }) => {
  const t         = (text || '').trim();
  const productId = t.startsWith('ADD_CART_') ? parseInt(t.split('_')[2]) : sess.shopProductId;
  if (!productId) return handleShoppingCart({ sess, customer });

  try {
    const summary = await mktCart.addItem(customer.id, productId, 1);
    const product = await mktCatalog.getProduct(productId);
    return {
      nextState: STATES.SHOPPING_PRODUCT,
      sessionData: { shopProductId: productId },
      replies: [{
        type: 'buttons',
        text: `✅ *${product?.name || 'Item'}* added to cart!

🛒 You have ${summary.count} item(s) — Total: KES ${summary.subtotal.toLocaleString('en-KE', { minimumFractionDigits: 2 })}`,
        buttons: [
          { buttonId: 'CART_VIEW',   buttonText: { displayText: '🛒 View Cart'         }, type: 1 },
          { buttonId: 'SHOP_MENU',   buttonText: { displayText: '🏠 Keep Shopping'      }, type: 1 },
          { buttonId: `PRD_${productId}`, buttonText: { displayText: '↩ Back to Item'  }, type: 1 },
        ],
      }],
    };
  } catch (err) {
    return {
      nextState: STATES.SHOPPING_PRODUCT,
      replies: [{ type: 'text', text: `❌ Could not add to cart: ${err.message}` }],
    };
  }
};

/** Show cart summary with action buttons */
const handleShoppingCart = async ({ customer, sess }) => {
  const summary  = await mktCart.getCartSummary(customer.id);
  const cartText = mktCart.buildCartText(summary);

  if (!summary.items.length) {
    return {
      nextState: STATES.SHOPPING_MAIN,
      replies: [{
        type: 'buttons',
        text: cartText,
        buttons: [
          { buttonId: 'SHOP_MENU', buttonText: { displayText: '🛍️ Browse Products' }, type: 1 },
        ],
      }],
    };
  }

  return {
    nextState: STATES.SHOPPING_CART,
    replies: [{
      type: 'buttons',
      text: cartText,
      buttons: [
        { buttonId: 'CHECKOUT_START',  buttonText: { displayText: '✅ Checkout'       }, type: 1 },
        { buttonId: 'SHOP_MENU',       buttonText: { displayText: '🛍️ Keep Shopping'  }, type: 1 },
        { buttonId: 'CART_CLEAR',      buttonText: { displayText: '🗑 Clear Cart'      }, type: 1 },
      ],
    }],
  };
};

/** Collect delivery address */
const handleCheckoutAddress = async ({ text, customer, sess }) => {
  const t = (text || '').trim();

  if (t === 'CART_CLEAR') {
    await mktCart.clearCart(customer.id);
    return { nextState: STATES.SHOPPING_MAIN, replies: [{ type: 'text', text: '🗑 Cart cleared. Reply *SHOP* to start over.' }] };
  }
  if (t === 'CHECKOUT_START' || t.toLowerCase() === 'checkout') {
    const summary = await mktCart.getCartSummary(customer.id);
    if (!summary.items.length) return handleShoppingCart({ customer, sess });
    return {
      nextState: STATES.CHECKOUT_ADDRESS,
      replies: [{
        type: 'text',
        text: `📍 *Where should we deliver?*

Please type your full delivery address:
_(Include building/estate, street, and town/city)_

Example: _Westlands Plaza, 3rd floor, Nairobi_`,
      }],
    };
  }

  // Address was typed
  const address = t;
  if (address.length < 10) {
    return {
      nextState: STATES.CHECKOUT_ADDRESS,
      replies: [{ type: 'text', text: '❌ Address too short. Please enter your full delivery address including estate, street, and town.' }],
    };
  }

  return {
    nextState: STATES.CHECKOUT_PAYMENT,
    sessionData: { checkoutAddress: address },
    replies: [{
      type: 'buttons',
      text: `📦 *Delivery to:*
${address}

💳 *How would you like to pay?*`,
      buttons: [
        { buttonId: 'PAY_MPESA', buttonText: { displayText: '📱 M-Pesa'           }, type: 1 },
        { buttonId: 'PAY_COD',   buttonText: { displayText: '🏠 Cash on Delivery'  }, type: 1 },
        { buttonId: 'PAY_BANK',  buttonText: { displayText: '🏦 Bank Transfer'     }, type: 1 },
      ],
    }],
  };
};

/** Handle payment method selection → create order */
const handleCheckoutPayment = async ({ text, customer, name, phone, sess }) => {
  const t      = (text || '').trim().toUpperCase();
  const method = t === 'PAY_MPESA' ? 'mpesa'
               : t === 'PAY_COD'   ? 'cod'
               : t === 'PAY_BANK'  ? 'bank'
               : null;

  if (!method) {
    return {
      nextState: STATES.CHECKOUT_PAYMENT,
      replies: [{ type: 'text', text: 'Please select a payment method using the buttons above.' }],
    };
  }

  const address = sess.checkoutAddress || 'Address not provided';

  try {
    const order = await mktCheckout.createOrder({
      customerId:      customer.id,
      deliveryAddress: address,
      paymentMethod:   method,
    });

    if (method === 'mpesa') {
      const stkResult = await mktCheckout.initiateMpesa(order, phone);
      if (stkResult.success) {
        return {
          nextState: STATES.CHECKOUT_MPESA,
          sessionData: { pendingOrderId: order.id, checkoutRequestId: stkResult.checkoutRequestId },
          replies: [{
            type: 'text',
            text: `📲 *M-Pesa prompt sent to ${phone}!*

Enter your M-Pesa PIN to pay:

💰 Amount: *KES ${parseFloat(order.total).toLocaleString('en-KE', { minimumFractionDigits: 2 })}*
📋 Ref: *${order.order_number}*

⏳ Waiting for confirmation…`,
          }],
        };
      }
      // STK push failed — fallback to manual paybill
      const instructions = mktCheckout.buildPaymentInstructions(order);
      return {
        nextState: STATES.CHECKOUT_MPESA,
        sessionData: { pendingOrderId: order.id },
        replies: [{ type: 'text', text: instructions + '\n\nReply *PAID <M-Pesa code>* once done.' }],
      };
    }

    // COD or Bank — confirm immediately
    const confirmation = mktCheckout.buildOrderConfirmation(order);
    return {
      nextState: STATES.MAIN_MENU,
      sessionData: { checkoutAddress: null },
      replies: [{ type: 'text', text: confirmation }, ...(await menu.buildMainMenu())],
    };
  } catch (err) {
    logger.error('checkout: createOrder failed', { phone, error: err.message });
    return {
      nextState: STATES.SHOPPING_CART,
      replies: [{ type: 'text', text: `❌ Checkout failed: ${err.message}. Please try again or type *MENU*.` }],
    };
  }
};

/** Handle M-Pesa pending state — accept manual payment codes */
const handleCheckoutMpesa = async ({ text, customer, sess }) => {
  const t = (text || '').trim();

  // Customer sending manual M-Pesa confirmation code: PAID QHJ7X...
  const paidMatch = t.match(/^PAID\s+([A-Z0-9]+)$/i);
  if (paidMatch) {
    const ref     = paidMatch[1].toUpperCase();
    const orderId = sess.pendingOrderId;
    if (orderId) {
      const order = await mktCheckout.getOrder(orderId);
      if (order) {
        await mktCheckout.confirmManualPayment(orderId, order.total, ref);
        const confirmation = mktCheckout.buildOrderConfirmation({ ...order, payment_method: 'mpesa', payment_status: 'paid' });
        return {
          nextState: STATES.MAIN_MENU,
          sessionData: { pendingOrderId: null },
          replies: [{ type: 'text', text: confirmation }, ...(await menu.buildMainMenu())],
        };
      }
    }
  }

  return {
    nextState: STATES.CHECKOUT_MPESA,
    replies: [{
      type: 'text',
      text: `⏳ Waiting for your M-Pesa payment.

If you've already paid, reply:
*PAID <M-Pesa code>*

Example: _PAID QHJ7XY123Z_

Or type *MENU* to go back.`,
    }],
  };
};

module.exports = { process, STATES };
