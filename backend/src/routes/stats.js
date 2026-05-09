const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function timeRange(q) {
  const start = q.start || null;
  const end   = q.end   || null;
  const clauses = [];
  const vals = [];
  let i = 1;
  if (start) { clauses.push(`start_time >= $${i++}`); vals.push(start); }
  if (end)   { clauses.push(`(end_time IS NULL OR end_time <= $${i++})`); vals.push(end); }
  return { where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', vals, nextIdx: i };
}

// GET /api/stats/overview
router.get('/overview', requireAuth, async (req, res) => {
  try {
    const { where, vals } = timeRange(req.query);
    const [totals, proto, recent] = await Promise.all([
      query(
        `SELECT COUNT(*)::int                   AS total_flows,
                COALESCE(SUM(total_bytes),0)    AS total_bytes,
                COALESCE(SUM(total_packets),0)  AS total_packets,
                COALESCE(AVG(flow_duration_ms),0) AS avg_duration_ms,
                COUNT(DISTINCT src_ip)::int     AS unique_src_ips,
                COUNT(DISTINCT dst_ip)::int     AS unique_dst_ips,
                COUNT(DISTINCT application)::int AS unique_apps
         FROM flows ${where}`, vals),
      query(
        `SELECT protocol,
                COUNT(*)::int    AS flows,
                SUM(total_bytes) AS bytes
         FROM flows ${where}
         GROUP BY protocol ORDER BY flows DESC`, vals),
      query(
        `SELECT COUNT(*)::int                AS flows_last_60s,
                COALESCE(SUM(total_bytes),0) AS bytes_last_60s
         FROM flows
         WHERE updated_at >= NOW() - INTERVAL '60 seconds'`),
    ]);

    const protoMap = { 6: 'TCP', 17: 'UDP', 1: 'ICMP' };
    const protoDist = proto.map(r => ({
      protocol: r.protocol,
      name: protoMap[r.protocol] || `Proto-${r.protocol}`,
      flows: r.flows,
      bytes: r.bytes,
    }));

    res.json({ ...totals[0], protocol_distribution: protoDist, ...recent[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats/top-apps
router.get('/top-apps', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '20'), 100);
    const byCol = ['total_bytes', 'total_flows', 'total_packets_sent'].includes(req.query.by)
                  ? req.query.by : 'total_bytes';
    const start = req.query.start || null;
    const end   = req.query.end   || null;

    let rows;
    if (start || end) {
      const clauses = [];
      const vals = [];
      let i = 1;
      if (start) { clauses.push(`f.start_time >= $${i++}`); vals.push(start); }
      if (end)   { clauses.push(`(f.end_time IS NULL OR f.end_time <= $${i++})`); vals.push(end); }
      const where = 'WHERE ' + clauses.join(' AND ');
      const byExpr = byCol === 'total_flows' ? 'COUNT(*)' :
                     byCol === 'total_packets_sent' ? 'SUM(f.total_packets)' :
                     'SUM(f.total_bytes)';
      rows = await query(
        `SELECT f.application,
                COALESCE(am.category, '') AS category,
                COUNT(*)::int             AS total_flows,
                SUM(f.bytes_sent)         AS total_bytes_sent,
                SUM(f.bytes_recv)         AS total_bytes_recv,
                SUM(f.total_bytes)        AS total_bytes,
                SUM(f.total_packets)      AS total_packets_sent,
                0                        AS total_packets_recv,
                MIN(f.start_time)        AS first_seen,
                MAX(f.end_time)          AS last_seen
         FROM flows f
         LEFT JOIN (
           SELECT application, MIN(category) AS category
           FROM application_mappings GROUP BY application
         ) am ON am.application = f.application
         ${where}
         GROUP BY f.application, am.category
         ORDER BY ${byExpr} DESC
         LIMIT $${i}`,
        [...vals, limit]
      );
    } else {
      rows = await query(
        `SELECT a.application,
                COALESCE(am.category, a.category, '') AS category,
                a.total_flows, a.total_bytes_sent, a.total_bytes_recv,
                (a.total_bytes_sent + a.total_bytes_recv) AS total_bytes,
                a.total_packets_sent, a.total_packets_recv,
                a.first_seen, a.last_seen
         FROM applications_summary a
         LEFT JOIN (
           SELECT application, MIN(category) AS category
           FROM application_mappings GROUP BY application
         ) am ON am.application = a.application
         ORDER BY ${byCol} DESC
         LIMIT $1`,
        [limit]
      );
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats/top-talkers
router.get('/top-talkers', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '20'), 100);
    const tClauses = [];
    const tVals = [];
    let i = 1;
    if (req.query.start) { tClauses.push(`f.start_time >= $${i++}`); tVals.push(req.query.start); }
    if (req.query.end)   { tClauses.push(`f.end_time <= $${i++}`);   tVals.push(req.query.end); }
    const tWhere = tClauses.length ? 'WHERE ' + tClauses.join(' AND ') : '';

    const [sources, destinations] = await Promise.all([
      query(
        `SELECT f.src_ip                        AS ip,
                COUNT(*)::int                   AS flows,
                SUM(f.bytes_sent)               AS bytes_sent,
                SUM(f.bytes_recv)               AS bytes_recv,
                SUM(f.total_bytes)              AS total_bytes,
                COALESCE(s.subscriber_id,'unknown') AS subscriber_id,
                COALESCE(s.name,'')             AS subscriber_name
         FROM flows f
         LEFT JOIN subscribers s ON s.ip_address = f.src_ip
         ${tWhere}
         GROUP BY f.src_ip, s.subscriber_id, s.name
         ORDER BY total_bytes DESC
         LIMIT $${i}`,
        [...tVals, limit]
      ),
      query(
        `SELECT f.dst_ip                AS ip,
                COUNT(*)::int          AS flows,
                SUM(f.bytes_recv)      AS bytes_recv,
                SUM(f.bytes_sent)      AS bytes_sent,
                SUM(f.total_bytes)     AS total_bytes
         FROM flows f
         ${tWhere}
         GROUP BY f.dst_ip
         ORDER BY total_bytes DESC
         LIMIT $${i}`,
        [...tVals, limit]
      ),
    ]);
    res.json({ sources, destinations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats/bandwidth
router.get('/bandwidth', requireAuth, async (req, res) => {
  try {
    const start = req.query.start || null;
    const end   = req.query.end   || null;

    let granularity = req.query.granularity === 'hour' ? 'hour' : 'minute';
    if (start && end && !req.query.granularity) {
      const spanHours = (new Date(end).getTime() - new Date(start).getTime()) / 3_600_000;
      if (spanHours > 72) granularity = 'hour';
    }

    // Build a bucket expression using date_trunc — safe because granularity is controlled
    const bucketExpr = `date_trunc('${granularity}', start_time)`;

    let whereSql, vals;
    if (start || end) {
      const clauses = [];
      vals = [];
      let i = 1;
      if (start) { clauses.push(`start_time >= $${i++}`); vals.push(start); }
      if (end)   { clauses.push(`start_time <= $${i++}`); vals.push(end); }
      whereSql = 'WHERE ' + clauses.join(' AND ');
    } else {
      const limit = Math.min(parseInt(req.query.limit || '60'), 1440);
      const unitExpr = granularity === 'hour' ? `($1 * INTERVAL '1 hour')` : `($1 * INTERVAL '1 minute')`;
      whereSql = `WHERE start_time >= NOW() - ${unitExpr}`;
      vals = [limit];
    }

    const rows = await query(
      `SELECT ${bucketExpr}   AS bucket,
              COUNT(*)::int   AS flows,
              SUM(total_bytes) AS bytes,
              SUM(bytes_sent)  AS bytes_sent,
              SUM(bytes_recv)  AS bytes_recv
       FROM flows
       ${whereSql}
       GROUP BY bucket
       ORDER BY bucket ASC`,
      vals
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats/protocol-distribution
router.get('/protocol-distribution', requireAuth, async (req, res) => {
  try {
    const { where, vals } = timeRange(req.query);
    const rows = await query(
      `SELECT protocol,
              COUNT(*)::int    AS flows,
              SUM(total_bytes) AS bytes,
              SUM(total_packets) AS packets
       FROM flows ${where}
       GROUP BY protocol
       ORDER BY bytes DESC`,
      vals
    );
    const protoMap = { 6: 'TCP', 17: 'UDP', 1: 'ICMP', 58: 'ICMPv6', 47: 'GRE' };
    res.json(rows.map(r => ({ ...r, name: protoMap[r.protocol] || `Proto-${r.protocol}` })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats/top-hostnames
router.get('/top-hostnames', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '20'), 100);
    const rows = await query(
      `SELECT hostname,
              COUNT(*)::int             AS occurrences,
              SUM(resolution_count)     AS total_resolutions
       FROM hostnames
       GROUP BY hostname
       ORDER BY occurrences DESC
       LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats/anomalies
router.get('/anomalies', requireAuth, async (req, res) => {
  try {
    const [spikes, highPorts, newApps] = await Promise.all([
      query(`
        SELECT src_ip, dst_ip, application, total_bytes, start_time
        FROM flows
        WHERE start_time >= NOW() - INTERVAL '5 minutes'
          AND total_bytes > (
            SELECT AVG(total_bytes) * 2 FROM flows
            WHERE start_time >= NOW() - INTERVAL '60 minutes'
          )
        ORDER BY total_bytes DESC
        LIMIT 20
      `),
      query(`
        SELECT src_ip,
               COUNT(DISTINCT dst_port)::int AS unique_dst_ports,
               COUNT(*)::int                AS flows
        FROM flows
        WHERE start_time >= NOW() - INTERVAL '5 minutes'
        GROUP BY src_ip
        HAVING COUNT(DISTINCT dst_port) > 20
        ORDER BY unique_dst_ports DESC
        LIMIT 20
      `),
      query(`
        SELECT application, MIN(start_time) AS first_seen, COUNT(*)::int AS flows
        FROM flows
        WHERE start_time >= NOW() - INTERVAL '24 hours'
          AND application NOT IN (
            SELECT DISTINCT application FROM flows
            WHERE start_time < NOW() - INTERVAL '24 hours'
          )
        GROUP BY application
        ORDER BY first_seen DESC
        LIMIT 20
      `),
    ]);
    res.json({ bandwidth_spikes: spikes, port_scanners: highPorts, new_applications: newApps });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats/history?period=hourly|daily|monthly
router.get('/history', requireAuth, async (req, res) => {
  try {
    const period = req.query.period || 'hourly';
    // trunc and interval values come from a hardcoded map — safe to interpolate
    const cfgMap = {
      hourly:  { trunc: 'hour',  interval: '7 days' },
      daily:   { trunc: 'day',   interval: '90 days' },
      monthly: { trunc: 'month', interval: '365 days' },
    };
    const { trunc, interval } = cfgMap[period] || cfgMap.hourly;

    const rows = await query(
      `SELECT date_trunc('${trunc}', start_time)       AS period,
              COUNT(*)::int                            AS flows,
              SUM(total_bytes)                         AS bytes,
              COUNT(DISTINCT src_ip)::int              AS unique_ips,
              COUNT(DISTINCT application)::int         AS unique_apps
       FROM flows
       WHERE start_time >= NOW() - INTERVAL '${interval}'
       GROUP BY period
       ORDER BY period ASC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats/app-detection
router.get('/app-detection', requireAuth, async (req, res) => {
  try {
    const [totals, unknown, byCategory] = await Promise.all([
      query("SELECT COUNT(*)::int AS total FROM flows WHERE start_time >= NOW() - INTERVAL '1 day'"),
      query("SELECT COUNT(*)::int AS cnt FROM flows WHERE (application IS NULL OR application IN ('Unknown','')) AND start_time >= NOW() - INTERVAL '1 day'"),
      query(`
        SELECT COALESCE(am.category, 'Unclassified') AS category,
               COUNT(*)::int                         AS flows,
               SUM(f.total_bytes)                    AS bytes
        FROM flows f
        LEFT JOIN (
          SELECT application, MIN(category) AS category
          FROM application_mappings GROUP BY application
        ) am ON am.application = f.application
        WHERE f.start_time >= NOW() - INTERVAL '1 day'
        GROUP BY am.category
        ORDER BY flows DESC
      `),
    ]);
    const total = totals[0].total || 1;
    const unk = unknown[0].cnt;
    res.json({
      total_flows: total,
      detected_flows: total - unk,
      undetected_flows: unk,
      detection_rate_pct: (((total - unk) / total) * 100).toFixed(2),
      by_category: byCategory,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats/app-usage
router.get('/app-usage', requireAuth, async (req, res) => {
  try {
    const { where, vals, nextIdx } = timeRange(req.query);
    const limit = Math.min(parseInt(req.query.limit || '200'), 1000);
    const rows = await query(
      `SELECT f.src_ip,
              COALESCE(s.subscriber_id, 'unknown') AS subscriber_id,
              COALESCE(s.name, '')                 AS subscriber_name,
              f.application,
              COALESCE(am.category, '')            AS category,
              COUNT(*)::int                        AS flows,
              SUM(f.total_bytes)                   AS total_bytes,
              SUM(f.total_packets)                 AS total_packets
       FROM flows f
       LEFT JOIN subscribers s    ON s.ip_address = f.src_ip
       LEFT JOIN (
         SELECT application, MIN(category) AS category
         FROM application_mappings GROUP BY application
       ) am ON am.application = f.application
       ${where}
       GROUP BY f.src_ip, f.application, s.subscriber_id, s.name, am.category
       ORDER BY total_bytes DESC
       LIMIT $${nextIdx}`,
      [...vals, limit]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
