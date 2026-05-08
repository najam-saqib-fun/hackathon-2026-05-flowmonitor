const express = require('express');
const bcrypt = require('bcryptjs');
const { query, queryOne } = require('../db');
const { signToken } = require('../auth');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const analytics = require('../analytics');

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
      analytics.track('user_login_failed', username, { username });
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    await query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);
    const token = signToken({ id: user.id, username: user.username, role: user.role });
    analytics.track('user_login', user.username, { role: user.role });
    res.json({ token, role: user.role, username: user.username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ id: req.user.id, username: req.user.username, role: req.user.role });
});

const VALID_ROLES = ['admin', 'operator', 'viewer'];

// POST /api/auth/users  (admin only)
router.post('/users', requireAdmin, async (req, res) => {
  try {
    const { username, password, role = 'viewer' } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
    const hash = await bcrypt.hash(password, 10);
    const result = await query('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', [username, hash, role]);
    analytics.track('user_created', req.user.username, { new_username: username, role });
    res.status(201).json({ id: result.insertId, username, role });
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

// PUT /api/auth/users/:id  (admin only)
router.put('/users/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { username, role, password } = req.body;
    if (role && !VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
    }
    // Prevent demoting the last admin
    if (role && role !== 'admin') {
      const target = await queryOne('SELECT role FROM users WHERE id = ?', [id]);
      if (target?.role === 'admin') {
        const [{ c }] = await query("SELECT COUNT(*) as c FROM users WHERE role = 'admin'");
        if (c <= 1) return res.status(400).json({ error: 'Cannot remove the last admin' });
      }
    }
    const updates = [];
    const vals = [];
    if (username) { updates.push('username = ?'); vals.push(username); }
    if (role)     { updates.push('role = ?');     vals.push(role); }
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      updates.push('password_hash = ?');
      vals.push(hash);
    }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(id);
    await query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, vals);
    analytics.track('user_updated', req.user.username, { target_id: id, role });
    res.json({ message: 'Updated' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Username already exists' });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/auth/users/:id  (admin only)
router.delete('/users/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (String(id) === String(req.user.id)) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    const target = await queryOne('SELECT role FROM users WHERE id = ?', [id]);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'admin') {
      const [{ c }] = await query("SELECT COUNT(*) as c FROM users WHERE role = 'admin'");
      if (c <= 1) return res.status(400).json({ error: 'Cannot delete the last admin' });
    }
    await query('DELETE FROM users WHERE id = ?', [id]);
    analytics.track('user_deleted', req.user.username, { target_id: id });
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
