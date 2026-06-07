'use strict';

/**
 * Menu builder — returns interactive WhatsApp message payloads.
 * Types:
 *   { type: 'list',    title, body, buttonText, sections }  — list picker (4+ options)
 *   { type: 'buttons', title, body, footer, buttons }       — button row (2–3 options)
 *   { type: 'text',    text }                               — plain text fallback
 */

// ── Consent ───────────────────────────────────────────────────────────────────

const CONSENT_INTRO = { type: 'text', text: 'Hello! 👋 This is *Laitor Invest Limited*.' };

const CONSENT_BUTTONS = {
  type:    'buttons',
  title:   'Permission to Contact You',
  body:    'We would like to send you information about our internet packages, products, and support services via WhatsApp.\n\nDo you agree?',
  footer:  'Reply STOP at any time to opt out.',
  buttons: [
    { id: '1', label: '✅ Yes, I accept' },
    { id: '2', label: '❌ No, opt out'   },
  ],
};

const CONSENT_MESSAGE = [CONSENT_INTRO, CONSENT_BUTTONS];

// ── Main menu ─────────────────────────────────────────────────────────────────

const MAIN_MENU = [
  {
    type:       'list',
    title:      '🌐 Laitor Invest',
    body:       'Welcome! How can we help you today?',
    footer:     'Reply STOP to opt out',
    buttonText: 'View Options',
    sections: [{
      title: 'Main Menu',
      rows: [
        { id: '1', title: '📶 Internet Packages',    description: 'Browse our internet plans'       },
        { id: '2', title: '📦 Products & Equipment', description: 'CCTV, routers, networking gear'  },
        { id: '3', title: '🔧 Technical Support',    description: 'Report an issue or fault'        },
        { id: '4', title: '👤 Speak to an Agent',    description: 'Get help from our team'          },
      ],
    }],
  },
];

// ── Internet catalog menu ─────────────────────────────────────────────────────

const buildInternetMenu = (items) => {
  if (!items.length) {
    return [{ type: 'text', text: 'Sorry, no internet packages are available right now.\n\nType *0* to go back.' }];
  }

  const rows = items.slice(0, 10).map((item, i) => ({
    id:          String(i + 1),
    title:       item.name,
    description: [
      parseFloat(item.price) > 0 ? 'KES ' + parseFloat(item.price).toLocaleString() : '',
      item.description || '',
    ].filter(Boolean).join(' — ').substring(0, 72),
  }));

  rows.push({ id: '0', title: '⬅️ Back to main menu', description: '' });

  return [{
    type:       'list',
    title:      '📶 Internet Packages',
    body:       'Select a package to see more details:',
    footer:     'Laitor Invest',
    buttonText: 'View Packages',
    sections:   [{ title: 'Available Plans', rows }],
  }];
};

// ── Product catalog menu ──────────────────────────────────────────────────────

const buildProductMenu = (items) => {
  if (!items.length) {
    return [{ type: 'text', text: 'Sorry, no products are available right now.\n\nType *0* to go back.' }];
  }

  const rows = items.slice(0, 10).map((item, i) => ({
    id:          String(i + 1),
    title:       item.name,
    description: [
      parseFloat(item.price) > 0 ? 'KES ' + parseFloat(item.price).toLocaleString() : '',
      item.description || '',
    ].filter(Boolean).join(' — ').substring(0, 72),
  }));

  rows.push({ id: '0', title: '⬅️ Back to main menu', description: '' });

  return [{
    type:       'list',
    title:      '📦 Products & Equipment',
    body:       'Select a product for more details:',
    footer:     'Laitor Invest',
    buttonText: 'View Products',
    sections:   [{ title: 'Available Products', rows }],
  }];
};

// ── Order confirmation ────────────────────────────────────────────────────────

const buildConfirmMenu = (itemName, price) => {
  const priceText = parseFloat(price) > 0
    ? 'Price: KES ' + parseFloat(price).toLocaleString()
    : 'Our team will confirm the price.';

  return [{
    type:    'buttons',
    title:   'Confirm Your Order',
    body:    'You selected: *' + itemName + '*\n' + priceText,
    footer:  'Laitor Invest',
    buttons: [
      { id: '1', label: '✅ Confirm Order' },
      { id: '2', label: '❌ Cancel'        },
    ],
  }];
};

// ── Other messages ────────────────────────────────────────────────────────────

const SUPPORT_PROMPT = [
  { type: 'text', text: '🔧 *Technical Support*\n\nPlease describe your issue in detail and we will log a support ticket.\n\nOur technical team will reach out to you shortly.' },
];

const AGENT_HANDOFF = [
  { type: 'text', text: '👤 *Connecting to an Agent*\n\nPlease hold on — a Laitor team member will message you shortly.\n\nType *MENU* at any time to return to the main menu.' },
];

const OPT_OUT_CONFIRM = [
  { type: 'text', text: 'You have been removed from our messaging list. We will not contact you further.\n\nIf you ever wish to reconnect, simply message us again. Thank you.' },
];

const OPT_IN_WELCOME = (name) => [
  { type: 'text', text: 'Thank you, ' + (name || 'valued customer') + '! You are now connected to *Laitor Invest*. 🎉' },
];

module.exports = {
  CONSENT_MESSAGE,
  MAIN_MENU,
  SUPPORT_PROMPT,
  AGENT_HANDOFF,
  OPT_OUT_CONFIRM,
  OPT_IN_WELCOME,
  buildInternetMenu,
  buildProductMenu,
  buildConfirmMenu,
};
