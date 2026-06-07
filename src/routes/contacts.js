'use strict';

/**
 * Contact import route.
 * POST /contacts/import  — multipart form upload of .xlsx or .csv
 *
 * Excel columns expected (case-insensitive, order flexible):
 *   Customer | Mobile phone | Service | Location | Cluster | Territories
 *
 * If Territories column is empty the Excel filename is used as the territory.
 */

const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const XLSX     = require('xlsx');
const { query } = require('../models/db');
const outreach = require('../services/outreach');
const logger   = require('../utils/logger');

const router  = express.Router();
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/** Normalise column header → standard key */
const normalise = (header) =>
  String(header || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');

const COLUMN_MAP = {
  customer:     ['customer', 'name', 'customername'],
  phone:        ['mobilephone', 'phone', 'mobile', 'phonenumber', 'contact'],
  service:      ['service', 'servicetag', 'servicetype'],
  location:     ['location', 'area', 'address'],
  cluster:      ['cluster'],
  territories:  ['territories', 'territory'],
};

const resolveColumns = (headers) => {
  const map = {};
  for (const [key, aliases] of Object.entries(COLUMN_MAP)) {
    const found = headers.find((h) => aliases.includes(normalise(h)));
    if (found) map[key] = found;
  }
  return map;
};

/** Sanitise phone → international format starting with 254 */
const sanitisePhone = (raw) => {
  if (!raw) return null;
  let p = String(raw).replace(/\D/g, '');
  if (p.startsWith('0'))   p = '254' + p.slice(1);
  if (p.startsWith('254')) return p;
  if (p.length === 9)      return '254' + p;
  return p.length >= 10 ? p : null;
};

/** Import contacts from a parsed sheet */
const importRows = async (rows, colMap, fallbackTerritory) => {
  let imported = 0;
  let skipped  = 0;
  const errors = [];

  for (const row of rows) {
    try {
      const phone = sanitisePhone(row[colMap.phone]);
      if (!phone) { skipped++; continue; }

      const name      = (row[colMap.customer] || '').trim() || null;
      const service   = (row[colMap.service]  || '').trim() || null;
      const location  = (row[colMap.location] || '').trim() || null;
      const cluster   = (row[colMap.cluster]  || '').trim() || null;
      const territory = (row[colMap.territories] || '').trim() || fallbackTerritory || null;

      await query(
        `INSERT INTO customers (phone, name, service_tag, location, cluster, territory, source, consent_status)
         VALUES ($1, $2, $3, $4, $5, $6, 'import', 'pending')
         ON CONFLICT (phone)
         DO UPDATE SET
           name        = COALESCE(EXCLUDED.name, customers.name),
           service_tag = COALESCE(EXCLUDED.service_tag, customers.service_tag),
           location    = COALESCE(EXCLUDED.location, customers.location),
           cluster     = COALESCE(EXCLUDED.cluster, customers.cluster),
           territory   = COALESCE(EXCLUDED.territory, customers.territory),
           updated_at  = NOW()`,
        [phone, name, service, location, cluster, territory]
      );
      imported++;
    } catch (err) {
      errors.push({ row, error: err.message });
      skipped++;
    }
  }

  return { imported, skipped, errors: errors.slice(0, 20) };
};

/**
 * POST /contacts/import
 * Body: multipart/form-data, field "file" = .xlsx or .csv
 * Optional query: ?blast=true  — immediately sends consent blast after import
 *                 ?territory=  — filter blast to this territory
 *                 ?cluster=    — filter blast to this cluster
 */
router.post('/import', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Send field "file" as multipart.' });
  }

  const ext = path.extname(req.file.originalname).toLowerCase();
  if (!['.xlsx', '.xls', '.csv'].includes(ext)) {
    return res.status(400).json({ error: 'Unsupported file type. Use .xlsx, .xls, or .csv.' });
  }

  // Territory fallback = filename without extension
  const fallbackTerritory = path.basename(req.file.originalname, ext);

  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet    = workbook.Sheets[workbook.SheetNames[0]];
    const rows     = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (!rows.length) {
      return res.status(400).json({ error: 'File is empty or has no rows.' });
    }

    const headers = Object.keys(rows[0]);
    const colMap  = resolveColumns(headers);

    if (!colMap.phone) {
      return res.status(400).json({
        error: 'Could not find phone column. Expected: "Mobile phone", "Phone", "Mobile", or "Contact".',
        foundHeaders: headers,
      });
    }

    logger.info('Contact import started', {
      filename: req.file.originalname,
      rows: rows.length,
      fallbackTerritory,
      colMap,
    });

    const result = await importRows(rows, colMap, fallbackTerritory);

    logger.info('Contact import complete', result);

    // Optionally kick off consent blast immediately
    let blast = null;
    if (req.query.blast === 'true') {
      blast = await outreach.runBlast({
        territory: req.query.territory || null,
        cluster:   req.query.cluster   || null,
      });
    }

    return res.json({
      success: true,
      filename: req.file.originalname,
      fallbackTerritory,
      ...result,
      blast: blast || undefined,
    });
  } catch (err) {
    logger.error('Contact import failed', { error: err.message });
    return res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

/**
 * POST /contacts/blast
 * Trigger a consent blast without importing.
 * Body: { territory?, cluster? }
 */
router.post('/blast', async (req, res) => {
  try {
    const { territory, cluster } = req.body || {};
    const result = await outreach.runBlast({ territory, cluster });
    return res.json({ success: true, ...result });
  } catch (err) {
    logger.error('Blast failed', { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /contacts/pending
 * List contacts awaiting consent (paginated).
 */
router.get('/pending', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || '50', 10),  500);
    const offset = parseInt(req.query.offset || '0', 10);
    const r = await query(
      `SELECT phone, name, territory, cluster, service_tag, created_at
       FROM customers WHERE consent_status = 'pending'
       ORDER BY created_at ASC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return res.json({ contacts: r.rows, count: r.rowCount });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
