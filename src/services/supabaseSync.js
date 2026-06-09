'use strict';
// Supabase sync disabled — Laitor uses its own PostgreSQL
const noop = () => Promise.resolve();
module.exports = { syncCustomer:noop, logMessage:noop, syncSession:noop, syncOrder:noop, syncOrderStatus:noop, syncMpesa:noop, logActivity:noop, syncProduct:noop };
