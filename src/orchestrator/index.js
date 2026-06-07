'use strict';

const { query } = require('../models/db');
const session = require('../services/session');
const { classify, INTENTS } = require('../services/intent');
const whatsapp = require('../services/whatsapp');
const crm = require('../services/crm');
const orderService = require('../services/order');
const ticketService = require('../services/ticket');
const admin = require('../services/admin');
const manager = require('../services/manager');
const logger = require('../utils/logger');

const STATES = {
  IDLE:              'IDLE',
  AWAITING_PRODUCT:  'AWAITING_PRODUCT',
  AWAITING_LOCATION: 'AWAITING_LOCATION',
};

const REPLIES = {
  INTERNET_LEAD_ACK: [
    'Laitor Invest - Internet Enquiry Received!',
    'Our sales team will contact you shortly.\n\nCould you share your location (area/estate)?',
  ],
  PRODUCT_ORDER_ASK: [
    'Great! Let us get your order started.',
    'What product are you looking for? (e.g. CCTV camera, router, network cable)\n\nAlso include the quantity if you know it.',
  ],
  PRODUCT_ORDER_ACK: (product) => [
    'Order received for: ' + product,
    'Our team has been notified and will confirm your order and pricing shortly.',
  ],
  SUPPORT_ACK: [
    'Support ticket logged!',
    'Our technical team has been notified and will reach out to you shortly.',
  ],
  GENERAL: [
    'Hello! Welcome to Laitor Invest.',
    'How can we help you today?\n\nInternet packages - type "internet" or "wifi"\nProducts & orders - type "buy" or "order"\nTechnical support - type "not working" or "support"',
  ],
  LOCATION_RECEIVED: (location) => [
    'Got it - ' + location + '. Our team will be in touch shortly to confirm coverage and package options.',
  ],
};

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
    logger.warn('Message log failed (non-fatal)', { error: err.message });
  }
};

const createLocalLead = async (customerId, type, notes, crmLeadId) => {
  const res = await query(
    `INSERT INTO leads (customer_id, type, notes, crm_lead_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [customerId, type, notes, crmLeadId]
  );
  return res.rows[0].id;
};

const handleInternetLead = async ({ customer, text, name, phone }) => {
  const crmPersonId = await crm.upsertPerson({ phone, name });
  if (crmPersonId && customer.id) {
    await query('UPDATE customers SET crm_id = $1 WHERE id = $2', [crmPersonId, customer.id]);
  }
  const crmLeadId = crmPersonId
    ? await crm.createLead({ crmPersonId, type: INTENTS.INTERNET_LEAD, notes: text })
    : null;
  let leadId = null;
  if (customer.id) {
    leadId = await createLocalLead(customer.id, INTENTS.INTERNET_LEAD, text, crmLeadId);
  }
  if (crmPersonId) await crm.logActivity({ crmPersonId, message: text, direction: 'in' });
  await admin.notifyNewLead({ leadId, phone, name, message: text });
  return { nextState: STATES.AWAITING_LOCATION, replies: REPLIES.INTERNET_LEAD_ACK };
};

const handleProductOrderStart = async () => {
  return { nextState: STATES.AWAITING_PRODUCT, replies: REPLIES.PRODUCT_ORDER_ASK };
};

const handleProductOrderComplete = async ({ customer, text, name, phone }) => {
  let order = null;
  if (customer.id) {
    order = await orderService.create({ customerId: customer.id, product: text, notes: text });
  }
  const crmPersonId = await crm.upsertPerson({ phone, name });
  if (crmPersonId) {
    await crm.createLead({ crmPersonId, type: INTENTS.PRODUCT_ORDER, notes: text });
    await crm.logActivity({ crmPersonId, message: text, direction: 'in' });
  }
  await admin.notifyNewOrder({
    orderId: order ? order.id : '?',
    phone,
    name,
    product: text,
    notes: text,
  });
  return { nextState: STATES.IDLE, replies: REPLIES.PRODUCT_ORDER_ACK(text) };
};

const handleSupportRequest = async ({ customer, text, name, phone }) => {
  let ticket = null;
  if (customer.id) {
    ticket = await ticketService.create({ customerId: customer.id, issue: text });
  }
  const crmPersonId = await crm.upsertPerson({ phone, name });
  if (crmPersonId) {
    await crm.createLead({ crmPersonId, type: INTENTS.SUPPORT_REQUEST, notes: text });
    await crm.logActivity({ crmPersonId, message: text, direction: 'in' });
  }
  await admin.notifyNewTicket({
    ticketId: ticket ? ticket.id : '?',
    phone,
    name,
    issue: text,
    priority: ticket ? ticket.priority : 'medium',
  });
  return { nextState: STATES.IDLE, replies: REPLIES.SUPPORT_ACK };
};

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
        // Create invoice in Manager.io when order is confirmed
        if (status === orderService.ORDER_STATUS.CONFIRMED) {
          const customerKey = await manager.upsertCustomer({
            phone: order.phone,
            name: order.phone,
          });
          await manager.createInvoice({
            customerKey,
            orderId: order.id,
            product: order.product,
            phone: order.phone,
          });
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

const process = async (msg) => {
  const { phone, name, text, msgId, raw } = msg;
  logger.info('Orchestrator processing message', { phone, msgId });

  await logMessage({ phone, direction: 'in', text, raw, msgId });

  const cmd = parseAdminCommand(text);
  if (cmd) {
    const adminReply = await handleAdminCommand({ cmd, phone });
    if (adminReply) {
      await whatsapp.sendText(phone, adminReply);
      return;
    }
  }

  let customer = { id: null, phone };
  try {
    customer = await upsertCustomer(phone, name);
  } catch (err) {
    logger.error('Customer upsert failed', { phone, error: err.message });
  }

  const sess = await session.get(phone);
  const currentState = sess.state || STATES.IDLE;

  let replies = REPLIES.GENERAL;
  let nextState = STATES.IDLE;

  try {
    if (currentState === STATES.AWAITING_PRODUCT) {
      const result = await handleProductOrderComplete({ customer, text, name, phone });
      replies = result.replies;
      nextState = result.nextState;

    } else if (currentState === STATES.AWAITING_LOCATION) {
      replies = REPLIES.LOCATION_RECEIVED(text);
      if (customer.id) {
        await query('UPDATE customers SET location = $1 WHERE id = $2', [text, customer.id]);
      }
      nextState = STATES.IDLE;

    } else {
      const { intent, confidence, matched } = classify(text);
      logger.info('Intent classified', { phone, intent, confidence, matched });

      switch (intent) {
        case INTENTS.INTERNET_LEAD: {
          const result = await handleInternetLead({ customer, text, name, phone });
          replies = result.replies;
          nextState = result.nextState;
          break;
        }
        case INTENTS.PRODUCT_ORDER: {
          const result = await handleProductOrderStart();
          replies = result.replies;
          nextState = result.nextState;
          break;
        }
        case INTENTS.SUPPORT_REQUEST: {
          const result = await handleSupportRequest({ customer, text, name, phone });
          replies = result.replies;
          nextState = result.nextState;
          break;
        }
        default:
          replies = REPLIES.GENERAL;
          nextState = STATES.IDLE;
          break;
      }
    }
  } catch (err) {
    logger.error('Orchestrator handler error', { phone, error: err.message });
    replies = ['We encountered an issue. Please try again or call us directly.'];
    nextState = STATES.IDLE;
  }

  await session.set(phone, { state: nextState, lastMessage: text, customerId: customer.id });

  try {
    await whatsapp.sendSequence(phone, replies);
    for (const r of replies) {
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

  logger.info('Orchestrator done', { phone, nextState });
};

module.exports = { process };
