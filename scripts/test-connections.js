#!/usr/bin/env node
/**
 * Laitor connection test script.
 * Usage:
 *   node scripts/test-connections.js                        (local, reads .env)
 *   BASE_URL=https://laitor.app.laitor.co.ke node scripts/test-connections.js
 */
'use strict';

require('dotenv').config();
const http  = require('http');
const https = require('https');

const BASE = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

const get = (url) => new Promise((resolve, reject) => {
  const mod = url.startsWith('https') ? https : http;
  mod.get(url, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
      catch { resolve({ status: res.statusCode, body: data }); }
    });
  }).on('error', reject);
});

(async () => {
  console.log('\nLaitor Connection Diagnostics');
  console.log('Server:', BASE);
  console.log('-'.repeat(52));

  try {
    const h = await get(BASE + '/health');
    const db = h.body && h.body.db === 'connected' ? 'OK' : 'ERROR';
    console.log('\n  /health  DB:', db, '  uptime:', Math.round((h.body && h.body.uptime) || 0) + 's');
  } catch (e) {
    console.log('\n  /health unreachable:', e.message);
    process.exit(1);
  }

  try {
    const d = await get(BASE + '/api/v1/diagnostics');
    const r = d.body && d.body.results ? d.body.results : {};
    const NAMES = { database: 'PostgreSQL', redis: 'Redis', whatsapp: 'Evolution API', crm: 'Twenty CRM', manager: 'Manager.io' };
    console.log('\n  External connections:\n');
    for (const [key, val] of Object.entries(r)) {
      const label = (NAMES[key] || key).padEnd(20);
      if (val.configured === false) {
        console.log('    ' + label + ' NOT CONFIGURED (env vars missing)');
      } else if (val.ok) {
        let extra = '';
        if (val.businesses && val.businesses.length) extra = ' | businesses: ' + val.businesses.join(', ');
        if (val.instances  && val.instances.length)  extra = ' | instances: '  + val.instances.map(function(i){return i.name+'('+i.status+')';}).join(', ');
        console.log('    ' + label + ' CONNECTED  ' + val.ms + 'ms' + extra);
      } else {
        const err = val.error || 'failed';
        const code = val.httpStatus ? ' [HTTP ' + val.httpStatus + ']' : '';
        console.log('    ' + label + ' FAILED  ' + err + code);
      }
    }
  } catch (e) {
    console.log('\n  Diagnostics call failed:', e.message);
  }

  console.log('\n' + '-'.repeat(52) + '\n');
})();
