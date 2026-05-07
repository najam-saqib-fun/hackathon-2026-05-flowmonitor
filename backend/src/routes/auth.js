const express = require('express');
const bcrypt = require('bcryptjs');
const { query, queryOne } = require('../db');
const { signToken } = require('../auth');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password required' });
    }
    const user = await queryOne(
      'SELECT id, username, password_hash, role FROM users WHERE username = ?',
      [username]
    );
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    await query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);
    const token = signToken({ id: user.id, username: user.username, role: user.role });
    res.json({ token, role: user.role, username: user.username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ id: req.user.id, username: req.user.username, role: req.user.role });
});

// POST /api/auth/users  (admin only)
router.post('/users', requireAdmin, async (req, res) => {
  try {
    const { username, password, role = 'viewer' } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    if (!['admin', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    const hash = await bcrypt.hash(password, 10);
    await query('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', [username, hash, role]);
    res.status(201).json({ message: 'User created', username, role });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Username already exists' });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/users  (admin only)
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const users = await query('SELECT id, username, role, created_at, last_login FROM users ORDER BY id');
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
