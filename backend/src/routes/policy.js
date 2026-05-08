const express = require('express');
const { query } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const analytics = require('../analytics');

const router = express.Router();

// GET /api/policy  — list all known applications with their policy status
router.get('/', requireAuth, async (req, res) => {
  try {
    // Applications with traffic stats + their policy (if any)
    // UNION with capture_policy entries that have no traffic yet
    const rows = await query(`
      SELECT
        a.application,
        COALESCE(a.category, '') as category,
        a.total_flows,
        a.total_bytes_sent + a.total_bytes_recv as total_bytes,
        a.last_seen,
        COALESCE(p.enabled, 1) as enabled
      FROM applications_summary a
      LEFT JOIN capture_policy p ON p.application = a.application

      UNION

      SELECT
        p.application,
        '' as category,
        0 as total_flows,
        0 as total_bytes,
        NULL as last_seen,
        p.enabled
      FROM capture_policy p
      WHERE p.application NOT IN (SELECT application FROM applications_summary)

      ORDER BY total_bytes DESC, application ASC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/policy/:application  — enable or disable an application
router.put('/:application', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { application } = req.params;
    const { enabled } = req.body;
    if (typeof enabled !== 'number' && typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be 0 or 1' });
    }
    const val = enabled ? 1 : 0;
    await query(
      'INSERT INTO capture_policy (application, enabled) VALUES (?, ?) ON DUPLICATE KEY UPDATE enabled = ?',
      [application, val, val]
    );
    analytics.track('policy_updated', req.user.username, { application, enabled: val });
    res.json({ application, enabled: val });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/policy/bulk  — update multiple applications at once
router.post('/bulk', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { updates } = req.body; // [{ application, enabled }]
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'updates must be a non-empty array' });
    }
    for (const u of updates) {
      const val = u.enabled ? 1 : 0;
      await query(
        'INSERT INTO capture_policy (application, enabled) VALUES (?, ?) ON DUPLICATE KEY UPDATE enabled = ?',
        [u.application, val, val]
      );
    }
    analytics.track('policy_bulk_updated', req.user.username, { count: updates.length });
    res.json({ updated: updates.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
