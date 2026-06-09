'use strict';
// Bridge routes removed — Laitor is now the single product
const router = require('express').Router();
router.get('/health', (_,res) => res.json({ ok:true }));
module.exports = router;
