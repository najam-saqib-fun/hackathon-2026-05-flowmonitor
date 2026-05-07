const express = require('express');
const { query, queryOne } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

const VALID_TYPES = new Set(['hostname_exact', 'hostname_suffix', 'ip_exact', 'ip_cidr']);

// GET /api/mappings
router.get('/', requireAuth, async (req, res) => {
  try {
    const limit   = Math.min(parseInt(req.query.limit  || '200'), 2000);
    const offset  = parseInt(req.query.offset || '0');
    const search  = req.query.search      || null;
    const type    = req.query.pattern_type || null;
    const app     = req.query.application  || null;

    const clauses = [];
    const vals    = [];
    if (search) { clauses.push('(pattern LIKE ? OR application LIKE ?)'); vals.push(`%${search}%`, `%${search}%`); }
    if (type)   { clauses.push('pattern_type = ?'); vals.push(type); }
    if (app)    { clauses.push('application LIKE ?'); vals.push(`%${app}%`); }

    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

    const [rows, countRows] = await Promise.all([
      query(`SELECT * FROM application_mappings ${where} ORDER BY priority DESC, CHAR_LENGTH(pattern) DESC LIMIT ? OFFSET ?`, [...vals, limit, offset]),
      query(`SELECT COUNT(*) as total FROM application_mappings ${where}`, vals),
    ]);
    res.json({ total: countRows[0].total, limit, offset, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mappings
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { pattern_type, pattern, application, category, priority = 100, notes } = req.body;
    if (!pattern_type || !pattern || !application) {
      return res.status(400).json({ error: 'pattern_type, pattern, application required' });
    }
    //{"error":"VALID_TYPES.includes is not a function"}
    if (!VALID_TYPES.has(pattern_type)) {
      return res.status(400).json({ error: `pattern_type must be one of: ${VALID_TYPES.join(', ')}` });
    }
    const result = await query(
      'INSERT INTO application_mappings (pattern_type, pattern, application, category, priority, notes) VALUES (?, ?, ?, ?, ?, ?)',
      [pattern_type, pattern.toLowerCase(), application, category || null, priority, notes || null]
    );
    res.status(201).json({ id: result.insertId, pattern_type, pattern, application });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Duplicate pattern' });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mappings/applications?q=  — distinct app names for autocomplete
router.get('/applications', requireAuth, async (req, res) => {
  try {
    const q = req.query.q || '';
    const rows = await query(
      'SELECT DISTINCT application FROM application_mappings WHERE application LIKE ? ORDER BY application LIMIT 30',
      [`%${q}%`]
    );
    res.json(rows.map(r => r.application));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/mappings/:id
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { pattern_type, pattern, application, category, priority, notes } = req.body;
    if (pattern_type && !VALID_TYPES.has(pattern_type)) {
      return res.status(400).json({ error: `Invalid pattern_type` });
    }
    await query(
      `UPDATE application_mappings SET
        pattern_type = COALESCE(?, pattern_type),
        pattern      = COALESCE(?, pattern),
        application  = COALESCE(?, application),
        category     = COALESCE(?, category),
        priority     = COALESCE(?, priority),
        notes        = COALESCE(?, notes)
       WHERE id = ?`,
      [pattern_type || null, pattern?.toLowerCase() || null, application || null,
       category || null, priority ?? null, notes || null, req.params.id]
    );
    res.json({ message: 'Updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/mappings/:id
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await query('DELETE FROM application_mappings WHERE id = ?', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mappings/import  — body: { format: 'csv'|'json', data: string }
router.post('/import', requireAdmin, async (req, res) => {
  try {
    const { format = 'csv', data } = req.body;
    if (!data) return res.status(400).json({ error: 'data required' });

    let rows = [];

    if (format === 'json') {
      const parsed = JSON.parse(data);
      rows = Array.isArray(parsed) ? parsed : parsed.rows || parsed.mappings || [];
    } else {
      // CSV: pattern_type,pattern,application,category,priority
      const lines = data.split('\n').map(l => l.trim()).filter(Boolean);
      const header = lines[0].toLowerCase().split(',').map(h => h.trim());
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',');
        const row = {};
        header.forEach((h, idx) => { row[h] = (parts[idx] || '').trim(); });
        rows.push(row);
      }
    }

    let inserted = 0, skipped = 0, errors = [];
    for (const row of rows) {
      const { pattern_type, pattern, application, category, priority = 100, notes } = row;
      if (!pattern_type || !pattern || !application) { skipped++; continue; }
      if (!VALID_TYPES.has(pattern_type)) { errors.push(`Invalid type: ${pattern_type}`); skipped++; continue; }
      try {
        await query(
          'INSERT IGNORE INTO application_mappings (pattern_type, pattern, application, category, priority, notes) VALUES (?, ?, ?, ?, ?, ?)',
          [pattern_type, pattern.trim().toLowerCase(), application.trim(), category ? category.trim() : null, parseInt(priority) || 100, notes ? notes.trim() : null]
        );
        inserted++;
      } catch { skipped++; }
    }
    res.json({ inserted, skipped, total: rows.length, errors: errors.slice(0, 10) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mappings/export?format=csv|json
router.get('/export', requireAuth, async (req, res) => {
  try {
    const format = req.query.format === 'json' ? 'json' : 'csv';
    const rows = await query('SELECT pattern_type, pattern, application, category, priority, notes FROM application_mappings ORDER BY priority DESC, id ASC');

    if (format === 'json') {
      res.setHeader('Content-Disposition', 'attachment; filename="application_mappings.json"');
      res.setHeader('Content-Type', 'application/json');
      return res.json(rows);
    }

    // CSV
    const header = 'pattern_type,pattern,application,category,priority,notes';
    const lines  = rows.map(r =>
      [r.pattern_type, r.pattern, r.application, r.category || '', r.priority, r.notes || '']
        .map(v => `"${String(v).replace(/"/g, '""')}"`)
        .join(',')
    );
    res.setHeader('Content-Disposition', 'attachment; filename="application_mappings.csv"');
    res.setHeader('Content-Type', 'text/csv');
    res.send([header, ...lines].join('\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
