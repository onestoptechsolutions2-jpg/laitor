'use strict';

const logger = require('../utils/logger');

/**
 * Intent constants — single source of truth across the codebase.
 */
const INTENTS = {
  INTERNET_LEAD:     'INTERNET_LEAD',
  PRODUCT_ORDER:     'PRODUCT_ORDER',
  SUPPORT_REQUEST:   'SUPPORT_REQUEST',
  GENERAL_INQUIRY:   'GENERAL_INQUIRY',
};

/**
 * Rule table: each rule has a priority (lower = higher priority),
 * a set of keywords, and the intent it maps to.
 *
 * Extend this table to add new rules — no code changes elsewhere needed.
 */
const RULES = [
  {
    priority: 1,
    intent: INTENTS.SUPPORT_REQUEST,
    keywords: [
      'not working', 'down', 'disconnected', 'no signal', 'slow internet',
      'outage', 'support', 'help', 'problem', 'issue', 'broken',
      'error', 'fault', 'reset', 'restart', 'reboot',
    ],
  },
  {
    priority: 2,
    intent: INTENTS.PRODUCT_ORDER,
    keywords: [
      'buy', 'order', 'purchase', 'price', 'cost', 'how much',
      'cctv', 'camera', 'router', 'modem', 'cable', 'equipment',
      'product', 'quote', 'invoice',
    ],
  },
  {
    priority: 3,
    intent: INTENTS.INTERNET_LEAD,
    keywords: [
      'internet', 'wifi', 'fibre', 'fiber', 'broadband', 'connection',
      'connect', 'package', 'plan', 'subscribe', 'subscription',
      'install', 'installation', 'new connection',
    ],
  },
];

/**
 * Classify a message text into an intent.
 * Returns the highest-priority matching intent, or GENERAL_INQUIRY as fallback.
 *
 * @param {string} text
 * @returns {{ intent: string, confidence: 'rule_match' | 'fallback', matched: string[] }}
 */
const classify = (text) => {
  const normalised = (text || '').toLowerCase().trim();
  const matched = [];

  // Sort by priority (lowest number first)
  const sortedRules = [...RULES].sort((a, b) => a.priority - b.priority);

  for (const rule of sortedRules) {
    const hits = rule.keywords.filter((kw) => normalised.includes(kw));
    if (hits.length > 0) {
      logger.debug('Intent classified', { intent: rule.intent, matched: hits });
      return { intent: rule.intent, confidence: 'rule_match', matched: hits };
    }
  }

  logger.debug('Intent fallback to GENERAL_INQUIRY', { text: normalised });
  return { intent: INTENTS.GENERAL_INQUIRY, confidence: 'fallback', matched: [] };
};

module.exports = { classify, INTENTS };
