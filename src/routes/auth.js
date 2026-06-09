/**
 * auth.js — Admin login / JWT issuance
 * POST /auth/login  → { token, user }
 * POST /auth/setup  → create first admin (only works when table is empty)
 * GET  /auth/me     → decode token
 *
 * Uses Node's built-in crypto (no jsonwebtoken dep).
 * Secret: ADMIN_JWT_SECRET env var (falls back to WEBHOOK_SECRET).
 */
'use strict';
const router = require('express').Router();
const crypto = require('crypto');
const { query } = require('../models/db');
const logger   = require('../utils/logger');

const JWT_SECRET = () => process.env.ADMIN_JWT_SECRET || process.env.WEBHOOK_SECRET || 'laitor-dev-secret';
const JWT_TTL    = 60 * 60 * 24 * 7; // 7 days

// ── Tiny HS256 JWT (no external dep) ────────────────────────────────────────
function signJwt(payload) {
  const header  = Buffer.from(JSON.stringify({ alg:'HS256', typ:'JWT' })).toString('base64url');
  const body    = Buffer.from(JSON.stringify({ ...payload, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000) + JWT_TTL })).toString('base64url');
  const sig     = crypto.createHmac('sha256', JWT_SECRET()).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyJwt(token) {
  try {
    const [h, b, s] = token.split('.');
    const expected  = crypto.createHmac('sha256', JWT_SECRET()).update(`${h}.${b}`).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(s, 'base64url'), Buffer.from(expected, 'base64url'))) return null;
    const payload = JSON.parse(Buffer.from(b, 'base64url').toString());
    if (payload.exp < Math.floor(Date.now()/1000)) return null;
    return payload;
  } catch { return null; }
}

// ── Middleware: adminAuth ────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  // 1. Bearer JWT
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    const payload = verifyJwt(auth.slice(7));
    if (payload) { req.admin = payload; return next(); }
  }
  // 2. Cookie (optional)
  const cookie = (req.headers.cookie || '').split(';').find(c => c.trim().startsWith('laitor_token='));
  if (cookie) {
    const token   = cookie.trim().slice('laitor_token='.length);
    const payload = verifyJwt(token);
    if (payload) { req.admin = payload; return next(); }
  }
  // 3. Dev bypass (no users in DB yet)
  if (process.env.NODE_ENV !== 'production' && process.env.ADMIN_BYPASS === 'true') {
    req.admin = { id: 0, username: 'dev', role: 'admin' };
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.admin || !roles.includes(req.admin.role)) {
      return res.status(403).json({ error: `Role ${roles.join('/')} required` });
    }
    next();
  };
}

// ── Password hashing ─────────────────────────────────────────────────────────
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(plain, stored) {
  const [salt, hash] = stored.split(':');
  const attempt = crypto.scryptSync(plain, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(attempt, 'hex'));
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /auth/setup — create first admin (only when no admins exist)
router.post('/setup', async (req, res) => {
  try {
    const { rows } = await query('SELECT COUNT(*) FROM admin_users WHERE role=\'admin\'');
    if (parseInt(rows[0].count) > 0) return res.status(403).json({ error: 'Setup already complete' });

    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'username, email, password required' });

    const passwordHash = hashPassword(password);
    const { rows: users } = await query(
      `INSERT INTO admin_users (username, email, password_hash, role) VALUES ($1,$2,$3,'admin') RETURNING id,username,email,role`,
      [username, email, passwordHash]
    );
    const token = signJwt({ id: users[0].id, username, email, role: 'admin' });
    logger.info('[auth] First admin created:', username);
    res.json({ token, user: users[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username + password required' });

    const { rows } = await query(
      `SELECT * FROM admin_users WHERE (username=$1 OR email=$1) AND active=true LIMIT 1`,
      [username]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const user = rows[0];
    if (!verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await query('UPDATE admin_users SET last_login=NOW() WHERE id=$1', [user.id]);
    const token = signJwt({ id: user.id, username: user.username, email: user.email, role: user.role, agentId: user.agent_id });
    logger.info('[auth] Login:', user.username, user.role);
    res
      .cookie('laitor_token', token, { httpOnly: true, sameSite: 'lax', maxAge: JWT_TTL * 1000 })
      .json({ token, user: { id: user.id, username: user.username, email: user.email, role: user.role } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /auth/me
router.get('/me', adminAuth, (req, res) => {
  res.json({ user: req.admin });
});

// POST /auth/logout
router.post('/logout', (_req, res) => {
  res.clearCookie('laitor_token').json({ ok: true });
});

// POST /auth/users — create additional users (admin only)
router.post('/users', adminAuth, requireRole('admin'), async (req, res) => {
  try {
    const { username, email, password, role = 'agent', agentId } = req.body;
    const passwordHash = hashPassword(password);
    const { rows } = await query(
      `INSERT INTO admin_users (username,email,password_hash,role,agent_id) VALUES ($1,$2,$3,$4,$5) RETURNING id,username,email,role`,
      [username, email, passwordHash, role, agentId || null]
    );
    res.json({ user: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/users', adminAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { rows } = await query('SELECT id,username,email,role,active,last_login,created_at FROM admin_users ORDER BY created_at');
    res.json({ users: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


/* ── Change own password ──────────────────────────────────────────────────── */
router.post('/change-password', adminAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: 'currentPassword and newPassword required' });
  if (newPassword.length < 8)
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  try {
    const { rows } = await query('SELECT * FROM admin_users WHERE id=$1', [req.admin.id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    if (!verifyPassword(currentPassword, rows[0].password_hash))
      return res.status(401).json({ error: 'Current password is incorrect' });
    const hash = hashPassword(newPassword);
    await query('UPDATE admin_users SET password_hash=$1 WHERE id=$2', [hash, req.admin.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Admin: update any user ───────────────────────────────────────────────── */
router.put('/users/:id', adminAuth, requireRole('admin'), async (req, res) => {
  const { role, active, password } = req.body;
  const updates = [];
  const vals    = [];
  if (role)              { updates.push(`role=$${vals.push(role)}`); }
  if (active !== undefined) { updates.push(`active=$${vals.push(active)}`); }
  if (password) {
    if (password.length < 8) return res.status(400).json({ error: 'Password too short' });
    updates.push(`password_hash=$${vals.push(hashPassword(password))}`);
  }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  try {
    await query(`UPDATE admin_users SET ${updates.join(',')} WHERE id=$${vals.length}`, vals);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, adminAuth, requireRole };
