'use strict';

const { query }   = require('../models/db');
const session     = require('../services/session');
const whatsapp    = require('../services/whatsapp');
const crm         = require('../services/crm');
const consent     = require('../services/consent');
const catalog     = require('../services/catalog');
const menu        = require('../services/menu');
const orderService  = require('../services/order');
const ticketService = require('../services/ticket');
const admin       = require('../services/admin');
const manager     = require('../services/manager');
const logger      = require('../utils/logger');

// ─── States ───────────────────────────────────────────────────────────────────

const STATES = {
  CONSENT_PENDING:     'CONSENT_PENDING',     // waiting for opt-in/opt-out reply
  MAIN_MENU:           'MAIN_MENU',           // showing main menu
  INTERNET_BROWSE:     'INTERNET_BROWSE',     // browsing internet packages
  PRODUCT_BROWSE:      'PRODUCT_BROWSE',      // browsing products
  INTERNET_CONFIRM:    'INTERNET_CONFIRM',    // confirming selected internet package
  PRODUCT_CONFIRM:     'PRODUCT_CONFIRM',     // confirming selected product
  SUPPORT_AWAIT:       'SUPPORT_AWAIT',       // waiting for support description
  AGENT_HANDOFF:       'AGENT_HANDOFF',       // handed off to human agent
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const upsertCustomer = async (phone, name) => {
  const res = await query(
    `INSERT INTO customers (phone, name)
     VALUES ($1, $2)
     ON CONFLICT (phone)
     DO UPDATE SET name = COALESCE(EXCLUDED.name, customers.name), updated_at = NOW()
     RETURNING *`,
    [phone, name || null]
  );
  return res.rows[0];
};

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

const syncToCRM = async ({ phone, name, type, notes }) => {
  try {
    const crmPersonId = await crm.upsertPerson({ phone, name });
    if (!crmPersonId) return null;
    const crmLeadId = await crm.createLead({ crmPersonId, type, notes });
    await crm.logActivity({ crmPersonId, message: notes || type, direction: 'in' });
    return { crmPersonId, crmLeadId };
  } catch (err) {
    logger.warn('CRM sync failed (non-fatal)', { error: err.message });
    return null;
  }
};

// ─── Admin command handler (unchanged from v1) ────────────────────────────────

const parseAdminCommand = (text) => {
  const match = text.trim().match(/^(TICKET|ORDER)#(\d+)\s+(\w+)(?:\s+(.+))?$/i);
  if (!match) return null;
  return {
    type:   match[1].toUpperCase(),
    id:     parseInt(match[2], 10),
    action: match[3].toUpperCase(),
    extra:  match[4] || null,
  };
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
        await whatsapp.sendText(
          ticket.phone,
          'Update on your support ticket #' + ticket.id + ':\nStatus: ' + status.replace('_', ' ').toUpperCase() +
          (cmd.extra ? '\nTechnician: ' + cmd.extra : '') +
          '\n\nThank you for your patience. - Laitor Support'
        );
        reply = 'Ticket #' + cmd.id + ' updated to ' + status;
      } else {
        reply = 'Ticket #' + cmd.id + ' not found';
      }
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
          await manager.createInvoice({ customerKey, orderId: order.id, product: order.product, phone: order.phone });
        }
        await whatsapp.sendText(
          order.phone,
          'Update on your order #' + order.id + ':\nProduct: ' + order.product + '\nStatus: ' + status.toUpperCase() +
          '\n\nThank you for choosing Laitor! - Laitor Team'
        );
        reply = 'Order #' + cmd.id + ' updated to ' + status;
      } else {
        reply = 'Order #' + cmd.id + ' not found';
      }
    }
  }

  return reply;
};

// ─── State handlers ───────────────────────────────────────────────────────────

/**
 * STEP 1 — Consent gate.
 * New contacts always get the consent message first.
 * On reply: 1/yes → give consent, show main menu.
 *           2/no/stop → deny consent, send opt-out confirmation.
 */
const handleConsentState = async ({ customer, text, phone }) => {
  const consentReply = consent.parseConsentReply(text);

  if (consentReply === consent.CONSENT_STATUS.GIVEN) {
    await consent.giveConsent(phone);
    // Update customer in DB
    await query(
      `UPDATE customers SET consent_status = 'given', consented_at = NOW() WHERE phone = $1`,
      [phone]
    );
    // Show main menu after a short welcome
    const name = customer.name || 'there';
    return {
      nextState: STATES.MAIN_MENU,
      replies: [
        `Thank you, ${name}! You are now connected to *Laitor Invest*. 🎉`,
        ...menu.MAIN_MENU,
      ],
    };
  }

  if (consentReply === consent.CONSENT_STATUS.DENIED) {
    await consent.denyConsent(phone);
    await query(
      `UPDATE customers SET consent_status = 'denied' WHERE phone = $1`,
      [phone]
    );
    return {
      nextState: STATES.CONSENT_PENDING,
      replies: menu.OPT_OUT_CONFIRM,
    };
  }

  // Unrecognised reply — resend consent message
  return {
    nextState: STATES.CONSENT_PENDING,
    replies: [
      'Please reply *1* to accept or *2* to opt out.',
    ],
  };
};

/**
 * STEP 2 — Main menu navigation.
 * 1 → Internet packages
 * 2 → Products
 * 3 → Support
 * 4 → Agent
 */
const handleMainMenu = async ({ text }) => {
  const choice = text.trim().replace(/[^0-9]/g, '');

  if (choice === '1') {
    const cat = await catalog.getCatalog();
    const internet = catalog.splitByType(cat).internet;
    return {
      nextState: STATES.INTERNET_BROWSE,
      replies: menu.buildInternetMenu(internet),
      sessionData: { catalogInternet: internet },
    };
  }

  if (choice === '2') {
    const cat = await catalog.getCatalog();
    const products = catalog.splitByType(cat).products;
    return {
      nextState: STATES.PRODUCT_BROWSE,
      replies: menu.buildProductMenu(products),
      sessionData: { catalogProducts: products },
    };
  }

  if (choice === '3') {
    return {
      nextState: STATES.SUPPORT_AWAIT,
      replies: menu.SUPPORT_PROMPT,
    };
  }

  if (choice === '4') {
    return {
      nextState: STATES.AGENT_HANDOFF,
      replies: menu.AGENT_HANDOFF,
    };
  }

  // Unrecognised — re-show menu
  return {
    nextState: STATES.MAIN_MENU,
    replies: ['Please reply with a number:\n\n' + menu.MAIN_MENU[1]],
  };
};

/**
 * STEP 3a — Internet package browse.
 * User replies with a number to select, or 0 to go back.
 */
const handleInternetBrowse = async ({ text, customer, phone, name, sess }) => {
  const choice = parseInt(text.trim(), 10);

  if (choice === 0 || text.toLowerCase() === 'menu') {
    return { nextState: STATES.MAIN_MENU, replies: menu.MAIN_MENU };
  }

  // Re-fetch catalog if not in session
  let items = sess.catalogInternet;
  if (!items) {
    const cat = await catalog.getCatalog();
    items = catalog.splitByType(cat).internet;
  }

  const selected = catalog.getByIndex(items, choice);
  if (!selected) {
    return {
      nextState: STATES.INTERNET_BROWSE,
      replies: [
        `Please reply with a number between 1 and ${items.length}, or *0* to go back.`,
      ],
      sessionData: { catalogInternet: items },
    };
  }

  return {
    nextState: STATES.INTERNET_CONFIRM,
    replies: menu.buildConfirmMenu(selected.name, selected.price),
    sessionData: { pendingItem: selected, catalogInternet: items },
  };
};

/**
 * STEP 3b — Product browse.
 */
const handleProductBrowse = async ({ text, customer, phone, name, sess }) => {
  const choice = parseInt(text.trim(), 10);

  if (choice === 0 || text.toLowerCase() === 'menu') {
    return { nextState: STATES.MAIN_MENU, replies: menu.MAIN_MENU };
  }

  let items = sess.catalogProducts;
  if (!items) {
    const cat = await catalog.getCatalog();
    items = catalog.splitByType(cat).products;
  }

  const selected = catalog.getByIndex(items, choice);
  if (!selected) {
    return {
      nextState: STATES.PRODUCT_BROWSE,
      replies: [
        `Please reply with a number between 1 and ${items.length}, or *0* to go back.`,
      ],
      sessionData: { catalogProducts: items },
    };
  }

  return {
    nextState: STATES.PRODUCT_CONFIRM,
    replies: menu.buildConfirmMenu(selected.name, selected.price),
    sessionData: { pendingItem: selected, catalogProducts: items },
  };
};

/**
 * STEP 4 — Confirm order (internet or product).
 */
const handleConfirm = async ({ text, customer, phone, name, sess, orderType }) => {
  const choice = text.trim().replace(/[^0-9]/g, '');

  if (choice === '2' || text.toLowerCase() === 'cancel') {
    const browseState = orderType === 'internet' ? STATES.INTERNET_BROWSE : STATES.PRODUCT_BROWSE;
    const items = orderType === 'internet' ? sess.catalogInternet : sess.catalogProducts;
    const browseMenu = orderType === 'internet'
      ? menu.buildInternetMenu(items || [])
      : menu.buildProductMenu(items || []);
    return { nextState: browseState, replies: browseMenu };
  }

  if (choice === '1') {
    const item = sess.pendingItem;
    if (!item) {
      return { nextState: STATES.MAIN_MENU, replies: menu.MAIN_MENU };
    }

    // Create order
    let order = null;
    if (customer.id) {
      order = await orderService.create({ customerId: customer.id, product: item.name, notes: item.name });
    }

    // Sync to CRM
    await syncToCRM({ phone, name, type: orderType === 'internet' ? 'INTERNET_LEAD' : 'PRODUCT_ORDER', notes: item.name });

    // Notify admin
    await admin.notifyNewOrder({
      orderId: order ? order.id : '?',
      phone,
      name,
      product: item.name,
      notes: `Selected from catalog via WhatsApp. Price: KES ${item.price || 'TBD'}`,
    });

    logger.info('Order placed from catalog', { phone, item: item.name, orderId: order?.id });

    return {
      nextState: STATES.MAIN_MENU,
      replies: [
        `✅ Order confirmed for: *${item.name}*\n\nOur team will reach out to you shortly to arrange delivery or installation.\n\nOrder reference: *#${order?.id || 'WA-' + Date.now()}*`,
        'Is there anything else we can help you with?\n\n' + menu.MAIN_MENU[1],
      ],
    };
  }

  // Unrecognised
  return {
    nextState: orderType === 'internet' ? STATES.INTERNET_CONFIRM : STATES.PRODUCT_CONFIRM,
    replies: ['Please reply *1* to confirm or *2* to cancel.'],
  };
};

/**
 * STEP 5 — Support: capture issue description, create ticket.
 */
const handleSupportAwait = async ({ text, customer, phone, name }) => {
  let ticket = null;
  if (customer.id) {
    ticket = await ticketService.create({ customerId: customer.id, issue: text });
  }

  await syncToCRM({ phone, name, type: 'SUPPORT_REQUEST', notes: text });

  await admin.notifyNewTicket({
    ticketId: ticket ? ticket.id : '?',
    phone,
    name,
    issue: text,
    priority: ticket ? ticket.priority : 'medium',
  });

  return {
    nextState: STATES.MAIN_MENU,
    replies: [
      `✅ Support ticket *#${ticket?.id || '?'}* logged.\n\nOur technical team has been notified and will reach out to you shortly.`,
      'Is there anything else we can help you with?\n\n' + menu.MAIN_MENU[1],
    ],
  };
};

// ─── Main process function ────────────────────────────────────────────────────

const process = async (msg) => {
  const { phone, name, text, msgId, raw } = msg;
  logger.info('Orchestrator processing', { phone, msgId });

  await logMessage({ phone, direction: 'in', text, raw, msgId });

  // Admin commands bypass all state
  const cmd = parseAdminCommand(text);
  if (cmd) {
    const adminReply = await handleAdminCommand({ cmd, phone });
    if (adminReply) {
      await whatsapp.sendText(phone, adminReply);
      return;
    }
  }

  // Global opt-out keyword
  if (/^stop$/i.test(text.trim())) {
    await consent.denyConsent(phone);
    await query(`UPDATE customers SET consent_status = 'denied' WHERE phone = $1`, [phone]);
    await whatsapp.sendSequence(phone, menu.OPT_OUT_CONFIRM);
    return;
  }

  // Global menu reset keyword
  const wantsMenu = /^(menu|hi|hello|hujambo|habari|start)$/i.test(text.trim());

  let customer = { id: null, phone };
  try {
    customer = await upsertCustomer(phone, name);
  } catch (err) {
    logger.error('Customer upsert failed', { phone, error: err.message });
  }

  const consentStatus = customer.consent_status || 'pending';

  // ── Consent gate: if not given, only handle consent replies ─────────────────
  if (consentStatus !== 'given') {
    if (consentStatus === 'denied') {
      // Silently ignore — they opted out
      logger.info('Message from opted-out contact ignored', { phone });
      return;
    }

    // pending — send consent request if first contact, or handle consent reply
    const sess = await session.get(phone);

    if (!sess.consentSent) {
      // First message — send consent request
      await whatsapp.sendSequence(phone, consent.CONSENT_MESSAGE);
      await session.set(phone, { ...sess, state: STATES.CONSENT_PENDING, consentSent: true, customerId: customer.id });
    } else {
      // They replied to consent message
      const result = await handleConsentState({ customer, text, phone });
      await session.set(phone, { state: result.nextState, customerId: customer.id, ...(result.sessionData || {}) });
      await whatsapp.sendSequence(phone, result.replies);
    }

    return;
  }

  // ── Consent given — run state machine ───────────────────────────────────────
  const sess = await session.get(phone);
  const currentState = sess.state || STATES.MAIN_MENU;

  let result;

  try {
    if (wantsMenu) {
      result = { nextState: STATES.MAIN_MENU, replies: menu.MAIN_MENU };

    } else if (currentState === STATES.MAIN_MENU) {
      result = await handleMainMenu({ text });

    } else if (currentState === STATES.INTERNET_BROWSE) {
      result = await handleInternetBrowse({ text, customer, phone, name, sess });

    } else if (currentState === STATES.PRODUCT_BROWSE) {
      result = await handleProductBrowse({ text, customer, phone, name, sess });

    } else if (currentState === STATES.INTERNET_CONFIRM) {
      result = await handleConfirm({ text, customer, phone, name, sess, orderType: 'internet' });

    } else if (currentState === STATES.PRODUCT_CONFIRM) {
      result = await handleConfirm({ text, customer, phone, name, sess, orderType: 'product' });

    } else if (currentState === STATES.SUPPORT_AWAIT) {
      result = await handleSupportAwait({ text, customer, phone, name });

    } else if (currentState === STATES.AGENT_HANDOFF) {
      // In agent handoff — just log, don't auto-reply
      logger.info('Message in agent handoff state (not auto-replied)', { phone });
      return;

    } else {
      // Unknown state — reset to main menu
      result = { nextState: STATES.MAIN_MENU, replies: menu.MAIN_MENU };
    }
  } catch (err) {
    logger.error('Orchestrator handler error', { phone, error: err.message, stack: err.stack });
    result = {
      nextState: STATES.MAIN_MENU,
      replies: ['We encountered an issue. Please try again.\n\nType *MENU* to return to the main menu.'],
    };
  }

  // Merge session data
  const newSess = {
    ...sess,
    state: result.nextState,
    lastMessage: text,
    customerId: customer.id,
    ...(result.sessionData || {}),
  };
  await session.set(phone, newSess);

  // Send replies
  try {
    await whatsapp.sendSequence(phone, result.replies);
    for (const r of result.replies) {
      await logMessage({
        phone,
        direction: 'out',
        text: r,
        raw: { automated: true },
        msgId: 'out-' + msgId + '-' + Date.now(),
      });
    }
  } catch (err) {
    logger.error('Failed to send WhatsApp reply', { phone, error: err.message });
  }

  logger.info('Orchestrator done', { phone, nextState: result.nextState });
};

module.exports = { process };
