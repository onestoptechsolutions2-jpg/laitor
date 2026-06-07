'use strict';

/**
 * Menu renderer — builds numbered WhatsApp message strings from catalog data.
 */

const MAIN_MENU = [
  'Welcome to *Laitor Invest* 🌐',
  'Please select an option:\n\n*1.* Internet Packages\n*2.* Products & Equipment\n*3.* Technical Support\n*4.* Speak to an Agent\n\nReply *STOP* at any time to opt out.',
];

const buildInternetMenu = (items) => {
  if (!items.length) {
    return ['Sorry, no internet packages are available right now. Please try again later or type *0* to go back to the main menu.'];
  }
  const lines = items.map((item, i) => {
    const price = parseFloat(item.price) > 0 ? ` — KES ${parseFloat(item.price).toLocaleString()}` : '';
    const desc = item.description ? `\n   ${item.description}` : '';
    return `*${i + 1}.* ${item.name}${price}${desc}`;
  });
  return [
    '*Internet Packages* 📶\n\nPlease select a package:\n\n' + lines.join('\n\n') + '\n\n*0.* Back to main menu',
  ];
};

const buildProductMenu = (items) => {
  if (!items.length) {
    return ['Sorry, no products are available right now. Please try again later or type *0* to go back to the main menu.'];
  }
  const lines = items.map((item, i) => {
    const price = parseFloat(item.price) > 0 ? ` — KES ${parseFloat(item.price).toLocaleString()}` : '';
    const desc = item.description ? `\n   ${item.description}` : '';
    return `*${i + 1}.* ${item.name}${price}${desc}`;
  });
  return [
    '*Products & Equipment* 📦\n\nPlease select a product:\n\n' + lines.join('\n\n') + '\n\n*0.* Back to main menu',
  ];
};

const buildConfirmMenu = (itemName, price) => {
  const priceText = parseFloat(price) > 0
    ? `\nPrice: *KES ${parseFloat(price).toLocaleString()}*`
    : '\nOur team will confirm pricing shortly.';
  return [
    `You selected: *${itemName}*${priceText}\n\nReply:\n*1.* Confirm order\n*2.* Cancel`,
  ];
};

const SUPPORT_PROMPT = [
  'Please describe your issue and we will log a support ticket for you.\n\nOur technical team will reach out to you shortly.',
];

const AGENT_HANDOFF = [
  'We are connecting you to a Laitor agent now.\n\nPlease hold on — an agent will message you shortly.\n\nType *MENU* at any time to return to the main menu.',
];

const OPT_OUT_CONFIRM = [
  'You have been removed from our messaging list. We will not contact you further.\n\nIf you ever wish to reconnect, simply message us again. Thank you.',
];

const OPT_IN_WELCOME = (name) => [
  `Thank you, ${name || 'valued customer'}! You are now connected to Laitor Invest. 🎉`,
  'We will keep you informed about our services and offers.',
];

module.exports = {
  MAIN_MENU,
  SUPPORT_PROMPT,
  AGENT_HANDOFF,
  OPT_OUT_CONFIRM,
  OPT_IN_WELCOME,
  buildInternetMenu,
  buildProductMenu,
  buildConfirmMenu,
};
