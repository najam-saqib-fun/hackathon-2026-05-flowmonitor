const express = require('express');
const { query, queryOne } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const analytics = require('../analytics');

const router = express.Router();

const VALID_METRICS = ['bytes_per_sec', 'flows_per_min', 'conn_per_ip', 'unusual_port'];

// GET /api/alerts/rules
router.get('/rules', requireAuth, async (req, res) => {
  try {
    const rows = await query(
      `SELECT r.*, u.username as created_by_name
       FROM alert_rules r
       LEFT JOIN users u ON u.id = r.created_by
       ORDER BY r.id`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/alerts/rules
router.post('/rules', requireAdmin, async (req, res) => {
  try {
    const {
      name, metric, threshold, window_seconds = 60,
      application, src_ip, dst_ip, protocol,
    } = req.body;

    if (!name || !metric || threshold === undefined) {
      return res.status(400).json({ error: 'name, metric, threshold required' });
    }
    if (!VALID_METRICS.includes(metric)) {
      return res.status(400).json({ error: `metric must be one of: ${VALID_METRICS.join(', ')}` });
    }

    const result = await query(
      `INSERT INTO alert_rules
         (name, metric, threshold, window_seconds, application, src_ip, dst_ip, protocol, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, metric, threshold, window_seconds, application || null, src_ip || null,
       dst_ip || null, protocol || null, req.user.id]
    );
    analytics.track('alert_rule_created', req.user.username, { name, metric, threshold, window_seconds, application });
    res.status(201).json({ id: result.insertId, name, metric, threshold });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/alerts/rules/:id
router.put('/rules/:id', requireAdmin, async (req, res) => {
  try {
    const { name, threshold, window_seconds, enabled, application, src_ip, dst_ip } = req.body;
    await query(
      `UPDATE alert_rules SET
         name = COALESCE(?, name),
         threshold = COALESCE(?, threshold),
         window_seconds = COALESCE(?, window_seconds),
         enabled = COALESCE(?, enabled),
         application = COALESCE(?, application),
         src_ip = COALESCE(?, src_ip),
         dst_ip = COALESCE(?, dst_ip)
       WHERE id = ?`,
      [name, threshold, window_seconds, enabled, application, src_ip, dst_ip, req.params.id]
    );
    res.json({ message: 'Updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/alerts/rules/:id
router.delete('/rules/:id', requireAdmin, async (req, res) => {
  try {
    await query('DELETE FROM alert_rules WHERE id = ?', [req.params.id]);
    analytics.track('alert_rule_deleted', req.user.username, { rule_id: req.params.id });
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/alerts/events
router.get('/events', requireAuth, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit || '50'), 500);
    const offset = parseInt(req.query.offset || '0');
    const ack    = req.query.acknowledged !== undefined ? parseInt(req.query.acknowledged) : null;

    const where = ack !== null ? 'WHERE e.acknowledged = ?' : '';
    const vals  = ack !== null ? [ack] : [];

    const rows = await query(
      `SELECT e.*, r.name as rule_name, r.metric
       FROM alert_events e
       LEFT JOIN alert_rules r ON r.id = e.rule_id
       ${where}
       ORDER BY e.triggered_at DESC
       LIMIT ? OFFSET ?`,
      [...vals, limit, offset]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/alerts/events/:id/acknowledge
router.post('/events/:id/acknowledge', requireAuth, async (req, res) => {
  try {
    await query('UPDATE alert_events SET acknowledged = 1 WHERE id = ?', [req.params.id]);
    analytics.track('alert_acknowledged', req.user.username, { event_id: req.params.id });
    res.json({ message: 'Acknowledged' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
