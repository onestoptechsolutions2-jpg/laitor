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
  QUOTE_PENDING:    'QUOTE_PENDING',   // Awaiting customer approve/decline tap
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
  if (choice === '1') {
    const cat      = await catalog.getCatalog();
    const internet = catalog.splitByType(cat).internet;
    return { nextState: STATES.INTERNET_BROWSE, replies: menu.buildInternetMenu(internet), sessionData: { catalogInternet: internet } };
  }
  if (choice === '2') {
    const cat      = await catalog.getCatalog();
    const products = catalog.splitByType(cat).products;
    return { nextState: STATES.PRODUCT_BROWSE, replies: menu.buildProductMenu(products), sessionData: { catalogProducts: products } };
  }
  if (choice === '3') return { nextState: STATES.SUPPORT_AWAIT, replies: await menu.buildSupportPrompt() };
  if (choice === '4') return { nextState: STATES.AGENT_HANDOFF, replies: await menu.buildAgentHandoff() };
  return { nextState: STATES.MAIN_MENU, replies: await menu.buildMainMenu() };
};

const handleInternetBrowse = async ({ text, sess }) => {
  const choice = parseInt(text.trim(), 10);
  if (choice === 0 || /^menu$/i.test(text.trim())) return { nextState: STATES.MAIN_MENU, replies: menu.MAIN_MENU };
  let items = sess.catalogInternet;
  if (!items) { const cat = await catalog.getCatalog(); items = catalog.splitByType(cat).internet; }
  const selected = catalog.getByIndex(items, choice);
  if (!selected) return { nextState: STATES.INTERNET_BROWSE, replies: [{ type: 'text', text: `Please pick a number 1–${items.length}, or 0 to go back.` }], sessionData: { catalogInternet: items } };
  return { nextState: STATES.INTERNET_CONFIRM, replies: menu.buildConfirmMenu(selected.name, selected.price), sessionData: { pendingItem: selected, catalogInternet: items } };
};

const handleProductBrowse = async ({ text, sess }) => {
  const choice = parseInt(text.trim(), 10);
  if (choice === 0 || /^menu$/i.test(text.trim())) return { nextState: STATES.MAIN_MENU, replies: menu.MAIN_MENU };
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
    if (!item) return { nextState: STATES.MAIN_MENU, replies: menu.MAIN_MENU };

    let order = null;
    if (customer.id) order = await orderService.create({ customerId: customer.id, product: item.name, notes: item.name });

    await syncToCRM({ phone, name, type: orderType === 'internet' ? 'INTERNET_LEAD' : 'PRODUCT_ORDER', notes: item.name });

    // Notify category agent
    await agentSvc.notifyNewOrder({ phone, name, product: item.name, orderId: order?.id || '?', notes: `KES ${item.price || 'TBD'}` });

    return {
      nextState: STATES.MAIN_MENU,
      replies: [
        { type: 'text', text: `✅ Order confirmed for: *${item.name}*\n\nOur team will reach out to arrange delivery or installation.\n\nRef: *#${order?.id || 'WA-' + Date.now()}*` },
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
  return {
    nextState: STATES.MAIN_MENU,
    replies: [
      { type: 'text', text: `✅ Support ticket *#${ticket?.id || '?'}* logged.\n\nOur technical team will reach out shortly.` },
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
      result = await handleMainMenu({ text });
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

module.exports = { process, STATES };
