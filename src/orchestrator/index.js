'use strict';

const { query }     = require('../models/db');
const session       = require('../services/session');
const whatsapp      = require('../services/whatsapp');
const crm           = require('../services/crm');
const consent       = require('../services/consent');
const catalog       = require('../services/catalog');
const menu          = require('../services/menu');
const orderService  = require('../services/order');
const ticketService = require('../services/ticket');
const admin         = require('../services/admin');
const manager       = require('../services/manager');
const logger        = require('../utils/logger');

// ─── States ───────────────────────────────────────────────────────────────────

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
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Upsert customer by phone. Never creates duplicates.
 * Inbound (not from import): set consent = 'given' immediately.
 */
const upsertCustomer = async (phone, name, isInbound) => {
  const res = await query(
    `INSERT INTO customers (phone, name, source, consent_status)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (phone)
     DO UPDATE SET
       name           = COALESCE(EXCLUDED.name, customers.name),
       updated_at     = NOW()
     RETURNING *`,
    [phone, name || null, isInbound ? 'inbound' : 'unknown', isInbound ? 'given' : 'pending']
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
    await crm.createLead({ crmPersonId, type, notes });
    await crm.logActivity({ crmPersonId, message: notes || type, direction: 'in' });
    return crmPersonId;
  } catch (err) {
    logger.warn('CRM sync failed (non-fatal)', { error: err.message });
    return null;
  }
};

/**
 * Check what KYC fields are still missing for this customer.
 * Returns the first missing field name, or null if complete.
 */
const nextKYCField = (customer) => {
  const name = customer.name;
  if (!name || name === 'Unknown' || name.trim() === '') return 'name';
  if (!customer.location) return 'location';
  return null; // KYC complete
};

// ─── KYC handlers ─────────────────────────────────────────────────────────────

const handleKYCName = async ({ text, customer, phone }) => {
  const name = text.trim();
  if (name.length < 2) {
    return {
      nextState: STATES.KYC_NAME,
      replies: [{ type: 'text', text: 'Please enter your full name (e.g. *John Kamau*).' }],
    };
  }
  // Save name to DB
  await query(`UPDATE customers SET name = $1 WHERE phone = $2`, [name, phone]);

  // Update CRM person if exists
  const crmPersonId = await crm.upsertPerson({ phone, name });
  if (crmPersonId) await crm.updatePerson(crmPersonId, { name });

  // Check next KYC field
  const updatedCustomer = { ...customer, name };
  const nextField = nextKYCField(updatedCustomer);

  if (nextField === 'location') {
    return {
      nextState: STATES.KYC_LOCATION,
      replies: [{ type: 'text', text: `Thanks ${name}! 👋\n\nOne more thing — which area or estate are you located in? (e.g. *Westlands*, *Kilimani*, *Mombasa Road*)` }],
    };
  }

  return {
    nextState: STATES.MAIN_MENU,
    replies: [{ type: 'text', text: `Thanks ${name}! You're all set. 🎉` }, ...menu.MAIN_MENU],
  };
};

const handleKYCLocation = async ({ text, customer, phone }) => {
  const location = text.trim();
  if (location.length < 2) {
    return {
      nextState: STATES.KYC_LOCATION,
      replies: [{ type: 'text', text: 'Please enter your area or estate name.' }],
    };
  }
  // Save to DB
  await query(`UPDATE customers SET location = $1 WHERE phone = $2`, [location, phone]);

  // Update CRM
  const crmPersonId = await crm.findPersonByPhone(phone).then((p) => p?.id).catch(() => null);
  if (crmPersonId) await crm.updatePerson(crmPersonId, { location });

  const name = customer.name || 'there';
  return {
    nextState: STATES.MAIN_MENU,
    replies: [
      { type: 'text', text: `Got it — *${location}*. We now have your full details on file. 📋` },
      ...menu.MAIN_MENU,
    ],
  };
};

// ─── Admin command handler ─────────────────────────────────────────────────────

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
    const statusMap = { RESOLVED: ticketService.TICKET_STATUS.RESOLVED, CLOSED: ticketService.TICKET_STATUS.CLOSED, IN_PROGRESS: ticketService.TICKET_STATUS.IN_PROGRESS, ASSIGNED: ticketService.TICKET_STATUS.IN_PROGRESS };
    const status = statusMap[cmd.action];
    if (status) {
      const ticket = await ticketService.updateStatus(cmd.id, status, cmd.extra);
      if (ticket) {
        await whatsapp.sendText(ticket.phone, 'Update on your support ticket #' + ticket.id + ':\nStatus: ' + status.replace('_', ' ') + (cmd.extra ? '\nTechnician: ' + cmd.extra : '') + '\n\nThank you for your patience. - Laitor Support');
        reply = 'Ticket #' + cmd.id + ' → ' + status;
      } else { reply = 'Ticket #' + cmd.id + ' not found'; }
    }
  }

  if (cmd.type === 'ORDER') {
    const statusMap = { CONFIRMED: orderService.ORDER_STATUS.CONFIRMED, PROCESSING: orderService.ORDER_STATUS.PROCESSING, FULFILLED: orderService.ORDER_STATUS.FULFILLED, CANCELLED: orderService.ORDER_STATUS.CANCELLED };
    const status = statusMap[cmd.action];
    if (status) {
      const order = await orderService.updateStatus(cmd.id, status);
      if (order) {
        if (status === orderService.ORDER_STATUS.CONFIRMED) {
          const customerKey = await manager.upsertCustomer({ phone: order.phone, name: order.phone });
          await manager.createInvoice({ customerKey, orderId: order.id, product: order.product, phone: order.phone });
        }
        await whatsapp.sendText(order.phone, 'Update on your order #' + order.id + ':\nProduct: ' + order.product + '\nStatus: ' + status.toUpperCase() + '\n\nThank you for choosing Laitor! - Laitor Team');
        reply = 'Order #' + cmd.id + ' → ' + status;
      } else { reply = 'Order #' + cmd.id + ' not found'; }
    }
  }
  return reply;
};

// ─── Main menu handler ─────────────────────────────────────────────────────────

const handleMainMenu = async ({ text }) => {
  const choice = text.trim().replace(/[^0-9]/g, '');
  if (choice === '1') {
    const cat = await catalog.getCatalog();
    const internet = catalog.splitByType(cat).internet;
    return { nextState: STATES.INTERNET_BROWSE, replies: menu.buildInternetMenu(internet), sessionData: { catalogInternet: internet } };
  }
  if (choice === '2') {
    const cat = await catalog.getCatalog();
    const products = catalog.splitByType(cat).products;
    return { nextState: STATES.PRODUCT_BROWSE, replies: menu.buildProductMenu(products), sessionData: { catalogProducts: products } };
  }
  if (choice === '3') return { nextState: STATES.SUPPORT_AWAIT, replies: menu.SUPPORT_PROMPT };
  if (choice === '4') return { nextState: STATES.AGENT_HANDOFF, replies: menu.AGENT_HANDOFF };
  return { nextState: STATES.MAIN_MENU, replies: menu.MAIN_MENU };
};

const handleInternetBrowse = async ({ text, sess }) => {
  const choice = parseInt(text.trim(), 10);
  if (choice === 0 || /^menu$/i.test(text.trim())) return { nextState: STATES.MAIN_MENU, replies: menu.MAIN_MENU };
  let items = sess.catalogInternet;
  if (!items) { const cat = await catalog.getCatalog(); items = catalog.splitByType(cat).internet; }
  const selected = catalog.getByIndex(items, choice);
  if (!selected) return { nextState: STATES.INTERNET_BROWSE, replies: [{ type: 'text', text: `Please select a number between 1 and ${items.length}, or 0 to go back.` }], sessionData: { catalogInternet: items } };
  return { nextState: STATES.INTERNET_CONFIRM, replies: menu.buildConfirmMenu(selected.name, selected.price), sessionData: { pendingItem: selected, catalogInternet: items } };
};

const handleProductBrowse = async ({ text, sess }) => {
  const choice = parseInt(text.trim(), 10);
  if (choice === 0 || /^menu$/i.test(text.trim())) return { nextState: STATES.MAIN_MENU, replies: menu.MAIN_MENU };
  let items = sess.catalogProducts;
  if (!items) { const cat = await catalog.getCatalog(); items = catalog.splitByType(cat).products; }
  const selected = catalog.getByIndex(items, choice);
  if (!selected) return { nextState: STATES.PRODUCT_BROWSE, replies: [{ type: 'text', text: `Please select a number between 1 and ${items.length}, or 0 to go back.` }], sessionData: { catalogProducts: items } };
  return { nextState: STATES.PRODUCT_CONFIRM, replies: menu.buildConfirmMenu(selected.name, selected.price), sessionData: { pendingItem: selected, catalogProducts: items } };
};

const handleConfirm = async ({ text, customer, phone, name, sess, orderType }) => {
  const choice = text.trim().replace(/[^0-9]/g, '');
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
    await admin.notifyNewOrder({ orderId: order?.id || '?', phone, name, product: item.name, notes: `KES ${item.price || 'TBD'}` });
    return {
      nextState: STATES.MAIN_MENU,
      replies: [
        { type: 'text', text: `✅ Order confirmed for: *${item.name}*\n\nOur team will reach out to arrange delivery or installation.\n\nRef: *#${order?.id || 'WA-' + Date.now()}*` },
        ...menu.MAIN_MENU,
      ],
    };
  }
  return { nextState: orderType === 'internet' ? STATES.INTERNET_CONFIRM : STATES.PRODUCT_CONFIRM, replies: [{ type: 'text', text: 'Please tap *Confirm Order* or *Cancel*.' }] };
};

const handleSupportAwait = async ({ text, customer, phone, name }) => {
  let ticket = null;
  if (customer.id) ticket = await ticketService.create({ customerId: customer.id, issue: text });
  await syncToCRM({ phone, name, type: 'SUPPORT_REQUEST', notes: text });
  await admin.notifyNewTicket({ ticketId: ticket?.id || '?', phone, name, issue: text, priority: ticket?.priority || 'medium' });
  return {
    nextState: STATES.MAIN_MENU,
    replies: [
      { type: 'text', text: `✅ Support ticket *#${ticket?.id || '?'}* logged.\n\nOur technical team will reach out to you shortly.` },
      ...menu.MAIN_MENU,
    ],
  };
};

// ─── Main process ──────────────────────────────────────────────────────────────

const process = async (msg) => {
  const { phone, name, text, msgId, raw } = msg;
  logger.info('Orchestrator processing', { phone, msgId });

  await logMessage({ phone, direction: 'in', text, raw, msgId });

  // Admin commands bypass all state
  const cmd = parseAdminCommand(text);
  if (cmd) {
    const adminReply = await handleAdminCommand({ cmd, phone });
    if (adminReply) { await whatsapp.sendText(phone, adminReply); return; }
  }

  // Global opt-out
  if (/^stop$/i.test(text.trim())) {
    await consent.denyConsent(phone);
    await query(`UPDATE customers SET consent_status = 'denied' WHERE phone = $1`, [phone]);
    await whatsapp.sendSequence(phone, menu.OPT_OUT_CONFIRM);
    return;
  }

  const wantsMenu = /^(menu|hi|hello|hujambo|habari|start)$/i.test(text.trim());

  // ── Upsert customer ──────────────────────────────────────────────────────────
  // Key rule: inbound contacts (messaging us first) get consent = 'given' automatically.
  // Only imported contacts (source='import') need explicit consent.
  let customer = { id: null, phone };
  try {
    // Check if they already exist
    const existing = await query(`SELECT * FROM customers WHERE phone = $1`, [phone]);

    if (existing.rows.length > 0) {
      customer = existing.rows[0];
      // If they exist but source is NOT import, ensure consent is given
      if (customer.source !== 'import' && customer.consent_status === 'pending') {
        await query(`UPDATE customers SET consent_status = 'given' WHERE phone = $1`, [phone]);
        customer.consent_status = 'given';
      }
    } else {
      // Brand new inbound contact — create with consent given
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
  const sess = await session.get(phone);

  // ── CONSENT GATE (imported contacts only) ───────────────────────────────────
  if (consentStatus !== 'given') {
    if (consentStatus === 'denied') {
      logger.info('Message from opted-out contact ignored', { phone });
      return;
    }

    // pending → only imports reach here
    if (!sess.consentSent) {
      await whatsapp.sendSequence(phone, consent.CONSENT_MESSAGE);
      await session.set(phone, { ...sess, state: STATES.CONSENT_PENDING, consentSent: true, customerId: customer.id });
    } else {
      // Handle their consent reply
      const consentReply = consent.parseConsentReply(text);
      if (consentReply === consent.CONSENT_STATUS.GIVEN) {
        await consent.giveConsent(phone);
        await query(`UPDATE customers SET consent_status = 'given', consented_at = NOW() WHERE phone = $1`, [phone]);
        const updatedCustomer = { ...customer, consent_status: 'given' };
        const nextField = nextKYCField(updatedCustomer);
        if (nextField === 'name') {
          await whatsapp.sendText(phone, `Thank you for accepting! 🎉\n\nTo serve you better, what is your full name?`);
          await session.set(phone, { state: STATES.KYC_NAME, customerId: customer.id });
        } else if (nextField === 'location') {
          await whatsapp.sendText(phone, `Thank you! 🎉\n\nWhich area or estate are you in?`);
          await session.set(phone, { state: STATES.KYC_LOCATION, customerId: customer.id });
        } else {
          await whatsapp.sendSequence(phone, [{ type: 'text', text: 'Thank you! You are now connected to *Laitor Invest*. 🎉' }, ...menu.MAIN_MENU]);
          await session.set(phone, { state: STATES.MAIN_MENU, customerId: customer.id });
        }
      } else if (consentReply === consent.CONSENT_STATUS.DENIED) {
        await consent.denyConsent(phone);
        await query(`UPDATE customers SET consent_status = 'denied' WHERE phone = $1`, [phone]);
        await whatsapp.sendSequence(phone, menu.OPT_OUT_CONFIRM);
      } else {
        await whatsapp.sendText(phone, 'Please tap *Yes, I accept* or *No, opt out*.');
        await session.set(phone, { ...sess, state: STATES.CONSENT_PENDING });
      }
    }
    return;
  }

  // ── CONSENTED — run state machine ────────────────────────────────────────────
  const currentState = sess.state || STATES.MAIN_MENU;

  // KYC check: on first interaction after consent, collect missing info
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
    // KYC complete — mark so we don't check again this session
    await session.set(phone, { ...sess, kycDone: true });
  }

  let result;

  try {
    if (wantsMenu) {
      result = { nextState: STATES.MAIN_MENU, replies: menu.MAIN_MENU };
    } else if (currentState === STATES.KYC_NAME) {
      result = await handleKYCName({ text, customer, phone });
    } else if (currentState === STATES.KYC_LOCATION) {
      result = await handleKYCLocation({ text, customer, phone });
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
      result = { nextState: STATES.MAIN_MENU, replies: menu.MAIN_MENU };
    }
  } catch (err) {
    logger.error('Orchestrator handler error', { phone, error: err.message, stack: err.stack });
    result = { nextState: STATES.MAIN_MENU, replies: [{ type: 'text', text: 'We encountered an issue. Type *MENU* to try again.' }] };
  }

  const newSess = { ...sess, state: result.nextState, lastMessage: text, customerId: customer.id, kycDone: result.nextState !== STATES.KYC_NAME && result.nextState !== STATES.KYC_LOCATION ? (sess.kycDone || result.nextState === STATES.MAIN_MENU) : false, ...(result.sessionData || {}) };
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

module.exports = { process };
