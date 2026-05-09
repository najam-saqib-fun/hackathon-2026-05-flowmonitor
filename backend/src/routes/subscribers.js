const express = require('express');
const { query, queryOne } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const analytics = require('../analytics');

const router = express.Router();

// GET /api/subscribers
router.get('/', requireAuth, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || '200'), 2000);
    const offset = parseInt(req.query.offset || '0');
    const search = req.query.search || null;

    const clauses = [];
    const vals    = [];
    let i = 1;
    if (search) {
      clauses.push(`(ip_address LIKE $${i} OR subscriber_id LIKE $${i+1} OR name LIKE $${i+2})`);
      vals.push(`%${search}%`, `%${search}%`, `%${search}%`);
      i += 3;
    }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

    const [rows, countRows] = await Promise.all([
      query(`SELECT * FROM subscribers ${where} ORDER BY ip_address LIMIT $${i} OFFSET $${i+1}`, [...vals, limit, offset]),
      query(`SELECT COUNT(*)::int AS total FROM subscribers ${where}`, vals),
    ]);
    res.json({ total: countRows[0].total, limit, offset, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/subscribers
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { ip_address, subscriber_id, name, notes } = req.body;
    if (!ip_address || !subscriber_id) {
      return res.status(400).json({ error: 'ip_address and subscriber_id required' });
    }
    const rows = await query(
      'INSERT INTO subscribers (ip_address, subscriber_id, name, notes) VALUES ($1, $2, $3, $4) RETURNING id',
      [ip_address, subscriber_id, name || null, notes || null]
    );
    analytics.track('subscriber_created', req.user.username, { ip_address, subscriber_id });
    res.status(201).json({ id: rows[0].id, ip_address, subscriber_id });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'IP address already mapped' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/subscribers/:id
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { ip_address, subscriber_id, name, notes } = req.body;
    await query(
      `UPDATE subscribers SET
        ip_address    = COALESCE($1, ip_address),
        subscriber_id = COALESCE($2, subscriber_id),
        name          = COALESCE($3, name),
        notes         = COALESCE($4, notes)
       WHERE id = $5`,
      [ip_address || null, subscriber_id || null, name || null, notes || null, req.params.id]
    );
    res.json({ message: 'Updated' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'IP address already mapped' });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/subscribers/:id
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await query('DELETE FROM subscribers WHERE id = $1', [req.params.id]);
    analytics.track('subscriber_deleted', req.user.username, { subscriber_id: req.params.id });
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/subscribers/import
router.post('/import', requireAdmin, async (req, res) => {
  try {
    const { format = 'csv', data } = req.body;
    if (!data) return res.status(400).json({ error: 'data required' });

    let rows = [];
    if (format === 'json') {
      const parsed = JSON.parse(data);
      rows = Array.isArray(parsed) ? parsed : parsed.rows || parsed.subscribers || [];
    } else {
      const lines = data.split('\n').map(l => l.trim()).filter(Boolean);
      const header = lines[0].toLowerCase().split(',').map(h => h.trim());
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',');
        const row = {};
        header.forEach((h, idx) => { row[h] = (parts[idx] || '').trim().replace(/^"|"$/g, ''); });
        rows.push(row);
      }
    }

    let inserted = 0, updated = 0, skipped = 0;
    for (const row of rows) {
      const { ip_address, subscriber_id, name, notes } = row;
      if (!ip_address || !subscriber_id) { skipped++; continue; }
      try {
        const existing = await queryOne('SELECT id FROM subscribers WHERE ip_address = $1', [ip_address]);
        if (existing) {
          await query(
            'UPDATE subscribers SET subscriber_id = $1, name = $2, notes = $3 WHERE ip_address = $4',
            [subscriber_id, name || null, notes || null, ip_address]
          );
          updated++;
        } else {
          await query(
            'INSERT INTO subscribers (ip_address, subscriber_id, name, notes) VALUES ($1, $2, $3, $4)',
            [ip_address, subscriber_id, name || null, notes || null]
          );
          inserted++;
        }
      } catch { skipped++; }
    }
    analytics.track('subscribers_imported', req.user.username, { format, inserted, updated, skipped, total: rows.length });
    res.json({ inserted, updated, skipped, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/subscribers/export?format=csv|json
router.get('/export', requireAuth, async (req, res) => {
  try {
    const format = req.query.format === 'json' ? 'json' : 'csv';
    const rows = await query('SELECT ip_address, subscriber_id, name, notes FROM subscribers ORDER BY ip_address');

    if (format === 'json') {
      res.setHeader('Content-Disposition', 'attachment; filename="subscribers.json"');
      res.setHeader('Content-Type', 'application/json');
      return res.json(rows);
    }

    const header = 'ip_address,subscriber_id,name,notes';
    const lines  = rows.map(r =>
      [r.ip_address, r.subscriber_id, r.name || '', r.notes || '']
        .map(v => `"${String(v).replace(/"/g, '""')}"`)
        .join(',')
    );
    res.setHeader('Content-Disposition', 'attachment; filename="subscribers.csv"');
    res.setHeader('Content-Type', 'text/csv');
    res.send([header, ...lines].join('\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
