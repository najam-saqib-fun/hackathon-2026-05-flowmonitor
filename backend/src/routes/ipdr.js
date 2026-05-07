const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/ipdr — list IPDR keys with filters, pagination, sorting
router.get('/', requireAuth, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || '100'), 1000);
    const offset = parseInt(req.query.offset || '0');
    const validSorts = ['k.last_seen','k.first_seen','k.bytes_sent','k.bytes_recv',
                        'k.packets_sent','k.packets_recv','k.src_ip','k.application'];
    const rawSort = req.query.sort ? `k.${req.query.sort}` : 'k.last_seen';
    const sort  = validSorts.includes(rawSort) ? rawSort : 'k.last_seen';
    const order = req.query.order === 'asc' ? 'ASC' : 'DESC';

    const clauses = [];
    const vals    = [];
    if (req.query.src_ip)      { clauses.push('k.src_ip = ?');          vals.push(req.query.src_ip); }
    if (req.query.dst_ip)      { clauses.push('k.dst_ip = ?');          vals.push(req.query.dst_ip); }
    if (req.query.application) { clauses.push('k.application LIKE ?');  vals.push(`%${req.query.application}%`); }
    if (req.query.subscriber)  { clauses.push('s.subscriber_id LIKE ?'); vals.push(`%${req.query.subscriber}%`); }
    if (req.query.status)      { clauses.push('k.status = ?');          vals.push(req.query.status); }
    if (req.query.key_string)  { clauses.push('k.key_string LIKE ?');   vals.push(`%${req.query.key_string}%`); }

    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

    const selectCols = `
      k.id, k.key_string, k.src_ip, k.dst_ip, k.dst_port, k.application,
      k.packets_sent, k.bytes_sent, k.packets_recv, k.bytes_recv,
      k.first_seen, k.last_seen, k.status,
      COALESCE(s.subscriber_id, 'unknown') as subscriber_id,
      COALESCE(s.name, '') as subscriber_name,
      COALESCE(am.category, '') as application_category`;

    const fromJoin = `FROM ipdr_keys k
      LEFT JOIN subscribers s ON s.ip_address = k.src_ip
      LEFT JOIN application_mappings am ON am.application = k.application
        AND am.pattern_type IN ('hostname_suffix','hostname_exact','ip_exact','ip_cidr')
        AND am.id = (SELECT MIN(am2.id) FROM application_mappings am2
                     WHERE am2.application = k.application LIMIT 1)`;

    const [rows, countRows] = await Promise.all([
      query(`SELECT ${selectCols} ${fromJoin} ${where} ORDER BY ${sort} ${order} LIMIT ? OFFSET ?`,
            [...vals, limit, offset]),
      query(`SELECT COUNT(*) as total FROM ipdr_keys k LEFT JOIN subscribers s ON s.ip_address = k.src_ip ${where}`, vals),
    ]);

    res.json({ total: countRows[0].total, limit, offset, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ipdr/:id/flows — get all flows for an IPDR key
router.get('/:id/flows', requireAuth, async (req, res) => {
  try {
    const rows = await query(`
      SELECT f.id, f.src_ip, f.dst_ip, f.src_port, f.dst_port, f.protocol,
             f.application, f.start_time, f.end_time, f.flow_duration_ms,
             f.packet_sent, f.packet_recv, f.bytes_sent, f.bytes_recv,
             f.total_packets, f.total_bytes, f.hostnames, f.urls, f.metadata,
             COALESCE(s.subscriber_id, 'unknown') as subscriber_id,
             COALESCE(am.category, '') as application_category
      FROM flows f
      LEFT JOIN subscribers s ON s.ip_address = f.src_ip
      LEFT JOIN (
        SELECT application, MIN(category) AS category
        FROM application_mappings GROUP BY application
      ) am ON am.application = f.application
      WHERE f.ipdr_key_id = ?
      ORDER BY f.start_time DESC
      LIMIT 500
    `, [req.params.id]);
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
