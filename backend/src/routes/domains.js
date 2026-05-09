const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/domains
router.get('/', requireAuth, async (req, res) => {
  try {
    const limit   = Math.min(parseInt(req.query.limit  || '100'), 1000);
    const offset  = parseInt(req.query.offset || '0');
    const search  = req.query.search  || null;
    const src_ip  = req.query.src_ip  || null;
    const start   = req.query.start   || null;
    const end     = req.query.end     || null;

    const clauses = [];
    const vals    = [];
    let i = 1;

    if (search)  { clauses.push(`h.hostname LIKE $${i++}`);  vals.push(`%${search}%`); }
    if (src_ip)  { clauses.push(`f.src_ip = $${i++}`);       vals.push(src_ip); }
    if (start)   { clauses.push(`h.first_seen >= $${i++}`);  vals.push(start); }
    if (end)     { clauses.push(`h.last_seen <= $${i++}`);   vals.push(end); }

    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

    const [rows, countRows] = await Promise.all([
      query(
        `SELECT h.id, h.hostname, h.flow_id, h.first_seen, h.last_seen, h.resolution_count,
                f.src_ip, f.dst_ip, f.src_port, f.dst_port, f.protocol,
                f.application,
                COALESCE(s.subscriber_id, 'unknown') AS subscriber_id,
                COALESCE(s.name, '') AS subscriber_name
         FROM hostnames h
         LEFT JOIN flows f       ON f.id = h.flow_id
         LEFT JOIN subscribers s ON s.ip_address = f.src_ip
         ${where}
         ORDER BY h.resolution_count DESC, h.last_seen DESC
         LIMIT $${i} OFFSET $${i + 1}`,
        [...vals, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::int AS total
         FROM hostnames h
         LEFT JOIN flows f ON f.id = h.flow_id
         ${where}`,
        vals
      ),
    ]);

    res.json({ total: countRows[0].total, limit, offset, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/domains/chart
router.get('/chart', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '20'), 100);
    const start = req.query.start || null;
    const end   = req.query.end   || null;

    const clauses = [];
    const vals    = [];
    let i = 1;
    if (start) { clauses.push(`h.first_seen >= $${i++}`); vals.push(start); }
    if (end)   { clauses.push(`h.last_seen <= $${i++}`);  vals.push(end); }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

    const rows = await query(
      `SELECT h.hostname,
              COUNT(*)::int                AS occurrences,
              SUM(h.resolution_count)      AS total_resolutions,
              COUNT(DISTINCT f.src_ip)::int AS unique_sources
       FROM hostnames h
       LEFT JOIN flows f ON f.id = h.flow_id
       ${where}
       GROUP BY h.hostname
       ORDER BY occurrences DESC
       LIMIT $${i}`,
      [...vals, limit]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/domains/unique-sources
router.get('/unique-sources', requireAuth, async (req, res) => {
  try {
    const rows = await query(
      `SELECT DISTINCT f.src_ip,
              COALESCE(s.subscriber_id, 'unknown') AS subscriber_id
       FROM hostnames h
       LEFT JOIN flows f       ON f.id = h.flow_id
       LEFT JOIN subscribers s ON s.ip_address = f.src_ip
       WHERE f.src_ip IS NOT NULL
       ORDER BY f.src_ip
       LIMIT 500`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
