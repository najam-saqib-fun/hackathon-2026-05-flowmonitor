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
      `SELECT r.*, u.username AS created_by_name
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

    const rows = await query(
      `INSERT INTO alert_rules
         (name, metric, threshold, window_seconds, application, src_ip, dst_ip, protocol, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [name, metric, threshold, window_seconds, application || null, src_ip || null,
       dst_ip || null, protocol || null, req.user.id]
    );
    analytics.track('alert_rule_created', req.user.username, { name, metric, threshold, window_seconds, application });
    res.status(201).json({ id: rows[0].id, name, metric, threshold });
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
         name           = COALESCE($1, name),
         threshold      = COALESCE($2, threshold),
         window_seconds = COALESCE($3, window_seconds),
         enabled        = COALESCE($4, enabled),
         application    = COALESCE($5, application),
         src_ip         = COALESCE($6, src_ip),
         dst_ip         = COALESCE($7, dst_ip)
       WHERE id = $8`,
      [name ?? null, threshold ?? null, window_seconds ?? null,
       enabled != null ? !!enabled : null,
       application ?? null, src_ip ?? null, dst_ip ?? null, req.params.id]
    );
    res.json({ message: 'Updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/alerts/rules/:id
router.delete('/rules/:id', requireAdmin, async (req, res) => {
  try {
    await query('DELETE FROM alert_rules WHERE id = $1', [req.params.id]);
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
    const ack    = req.query.acknowledged !== undefined ? req.query.acknowledged === '1' || req.query.acknowledged === 'true' : null;

    const where = ack !== null ? 'WHERE e.acknowledged = $1' : '';
    const vals  = ack !== null ? [ack] : [];
    const li = vals.length + 1;
    const oi = vals.length + 2;

    const rows = await query(
      `SELECT e.*, r.name AS rule_name, r.metric
       FROM alert_events e
       LEFT JOIN alert_rules r ON r.id = e.rule_id
       ${where}
       ORDER BY e.triggered_at DESC
       LIMIT $${li} OFFSET $${oi}`,
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
    await query('UPDATE alert_events SET acknowledged = TRUE WHERE id = $1', [req.params.id]);
    analytics.track('alert_acknowledged', req.user.username, { event_id: req.params.id });
    res.json({ message: 'Acknowledged' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
