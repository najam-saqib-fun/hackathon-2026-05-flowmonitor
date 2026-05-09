const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function timeRange(q) {
  const start = q.start || null;
  const end   = q.end   || null;
  const clauses = [];
  const vals = [];
  if (start) { clauses.push('start_time >= ?'); vals.push(start); }
  // Include active flows (end_time IS NULL) that started within the window.
  // Without this, every page refresh excludes in-progress flows and the
  // Total Bytes KPI oscillates as flows complete/restart.
  if (end)   { clauses.push('(end_time IS NULL OR end_time <= ?)'); vals.push(end); }
  return { where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', vals };
}

// GET /api/stats/overview  — high-level KPIs
router.get('/overview', requireAuth, async (req, res) => {
  try {
    const { where, vals } = timeRange(req.query);
    const [totals, proto, recent] = await Promise.all([
      query(
        `SELECT COUNT(*) as total_flows,
                COALESCE(SUM(total_bytes), 0)   as total_bytes,
                COALESCE(SUM(total_packets), 0) as total_packets,
                COALESCE(AVG(flow_duration_ms), 0) as avg_duration_ms,
                COUNT(DISTINCT src_ip) as unique_src_ips,
                COUNT(DISTINCT dst_ip) as unique_dst_ips,
                COUNT(DISTINCT application) as unique_apps
         FROM flows ${where}`, vals),
      query(
        `SELECT protocol,
                COUNT(*) as flows,
                SUM(total_bytes) as bytes
         FROM flows ${where}
         GROUP BY protocol ORDER BY flows DESC`, vals),
      query(
        `SELECT COUNT(*) as flows_last_60s,
                COALESCE(SUM(total_bytes), 0) as bytes_last_60s
         FROM flows
         WHERE updated_at >= NOW() - INTERVAL 60 SECOND`),
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
      // Time-filtered: aggregate directly from flows table
      const clauses = [];
      const vals = [];
      if (start) { clauses.push('f.start_time >= ?'); vals.push(start); }
      if (end)   { clauses.push('(f.end_time IS NULL OR f.end_time <= ?)'); vals.push(end); }
      const where = 'WHERE ' + clauses.join(' AND ');
      const byExpr = byCol === 'total_flows' ? 'COUNT(*)' :
                     byCol === 'total_packets_sent' ? 'SUM(f.total_packets)' :
                     'SUM(f.total_bytes)';
      rows = await query(
        `SELECT f.application,
                COALESCE(am.category, '') AS category,
                COUNT(*) AS total_flows,
                SUM(f.bytes_sent) AS total_bytes_sent,
                SUM(f.bytes_recv) AS total_bytes_recv,
                SUM(f.total_bytes) AS total_bytes,
                SUM(f.total_packets) AS total_packets_sent,
                0 AS total_packets_recv,
                MIN(f.start_time) AS first_seen,
                MAX(f.end_time) AS last_seen
         FROM flows f
         LEFT JOIN (
           SELECT application, MIN(category) AS category
           FROM application_mappings GROUP BY application
         ) am ON am.application = f.application
         ${where}
         GROUP BY f.application
         ORDER BY ${byExpr} DESC
         LIMIT ?`,
        [...vals, limit]
      );
    } else {
      // No filter: use pre-aggregated summary table (fast)
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
         LIMIT ?`,
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
    const { where, vals } = timeRange(req.query);
    const limit = Math.min(parseInt(req.query.limit || '20'), 100);

    // Build time range clauses with explicit table prefix
    const tClauses = [];
    const tVals = [];
    if (req.query.start) { tClauses.push('f.start_time >= ?'); tVals.push(req.query.start); }
    if (req.query.end)   { tClauses.push('f.end_time <= ?');   tVals.push(req.query.end); }
    const tWhere = tClauses.length ? 'WHERE ' + tClauses.join(' AND ') : '';

    const [sources, destinations] = await Promise.all([
      query(
        `SELECT f.src_ip AS ip, COUNT(*) AS flows,
                SUM(f.bytes_sent) AS bytes_sent,
                SUM(f.bytes_recv) AS bytes_recv,
                SUM(f.total_bytes) AS total_bytes,
                COALESCE(s.subscriber_id, 'unknown') AS subscriber_id,
                COALESCE(s.name, '') AS subscriber_name
         FROM flows f
         LEFT JOIN subscribers s ON s.ip_address = f.src_ip
         ${tWhere}
         GROUP BY f.src_ip, s.subscriber_id, s.name
         ORDER BY total_bytes DESC
         LIMIT ?`,
        [...tVals, limit]
      ),
      query(
        `SELECT f.dst_ip AS ip, COUNT(*) AS flows,
                SUM(f.bytes_recv) AS bytes_recv,
                SUM(f.bytes_sent) AS bytes_sent,
                SUM(f.total_bytes) AS total_bytes
         FROM flows f
         ${tWhere}
         GROUP BY f.dst_ip
         ORDER BY total_bytes DESC
         LIMIT ?`,
        [...tVals, limit]
      ),
    ]);
    res.json({ sources, destinations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats/bandwidth  — time-series bytes per minute/hour
// Accepts ?start=&end= for explicit range, otherwise falls back to last ?limit= periods.
router.get('/bandwidth', requireAuth, async (req, res) => {
  try {
    const start = req.query.start || null;
    const end   = req.query.end   || null;

    // Auto-pick granularity: if a range is given use hour when span > 3 days, else minute.
    let granularity = req.query.granularity === 'hour' ? 'hour' : 'minute';
    if (start && end && !req.query.granularity) {
      const spanHours = (new Date(end).getTime() - new Date(start).getTime()) / 3_600_000;
      if (spanHours > 72) granularity = 'hour';
    }

    const format = granularity === 'hour' ? '%Y-%m-%d %H:00:00' : '%Y-%m-%d %H:%i:00';

    let whereSql, vals;
    if (start || end) {
      const clauses = [];
      vals = [];
      if (start) { clauses.push('start_time >= ?'); vals.push(start); }
      if (end)   { clauses.push('start_time <= ?'); vals.push(end); }
      whereSql = 'WHERE ' + clauses.join(' AND ');
    } else {
      const limit = Math.min(parseInt(req.query.limit || '60'), 1440);
      whereSql = `WHERE start_time >= NOW() - INTERVAL ? ${granularity === 'hour' ? 'HOUR' : 'MINUTE'}`;
      vals = [limit];
    }

    const rows = await query(
      `SELECT DATE_FORMAT(start_time, ?) as bucket,
              COUNT(*) as flows,
              SUM(total_bytes) as bytes,
              SUM(bytes_sent) as bytes_sent,
              SUM(bytes_recv) as bytes_recv
       FROM flows
       ${whereSql}
       GROUP BY bucket
       ORDER BY bucket ASC`,
      [format, ...vals]
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
              COUNT(*) as flows,
              SUM(total_bytes) as bytes,
              SUM(total_packets) as packets
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
      `SELECT hostname, COUNT(*) as occurrences, SUM(resolution_count) as total_resolutions
       FROM hostnames
       GROUP BY hostname
       ORDER BY occurrences DESC
       LIMIT ?`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats/anomalies  — flows with unusual byte spikes or high port counts
router.get('/anomalies', requireAuth, async (req, res) => {
  try {
    const [spikes, highPorts, newApps] = await Promise.all([
      // flows in last 5 min with bytes > 2x average of same hour
      query(`
        SELECT src_ip, dst_ip, application, total_bytes, start_time
        FROM flows
        WHERE start_time >= NOW() - INTERVAL 5 MINUTE
          AND total_bytes > (
            SELECT AVG(total_bytes) * 2 FROM flows
            WHERE start_time >= NOW() - INTERVAL 60 MINUTE
          )
        ORDER BY total_bytes DESC
        LIMIT 20
      `),
      // IPs with many distinct destination ports (potential scanner)
      query(`
        SELECT src_ip,
               COUNT(DISTINCT dst_port) as unique_dst_ports,
               COUNT(*) as flows
        FROM flows
        WHERE start_time >= NOW() - INTERVAL 5 MINUTE
        GROUP BY src_ip
        HAVING unique_dst_ports > 20
        ORDER BY unique_dst_ports DESC
        LIMIT 20
      `),
      // applications seen for the first time today
      query(`
        SELECT application, MIN(start_time) as first_seen, COUNT(*) as flows
        FROM flows
        WHERE start_time >= NOW() - INTERVAL 24 HOUR
          AND application NOT IN (
            SELECT DISTINCT application FROM flows
            WHERE start_time < NOW() - INTERVAL 24 HOUR
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
    const formatMap = {
      hourly:  { fmt: '%Y-%m-%d %H:00:00', interval: '7 DAY' },
      daily:   { fmt: '%Y-%m-%d',           interval: '90 DAY' },
      monthly: { fmt: '%Y-%m',              interval: '365 DAY' },
    };
    const { fmt, interval } = formatMap[period] || formatMap.hourly;

    const rows = await query(
      `SELECT DATE_FORMAT(start_time, ?) as period,
              COUNT(*) as flows,
              SUM(total_bytes) as bytes,
              COUNT(DISTINCT src_ip) as unique_ips,
              COUNT(DISTINCT application) as unique_apps
       FROM flows
       WHERE start_time >= NOW() - INTERVAL ${interval}
       GROUP BY period
       ORDER BY period ASC`,
      [fmt]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats/app-detection  — detection rate metrics
router.get('/app-detection', requireAuth, async (req, res) => {
  try {
    const [totals, unknown, byCategory] = await Promise.all([
      query("SELECT COUNT(*) as total FROM flows WHERE start_time >= NOW() - INTERVAL 1 DAY"),
      query("SELECT COUNT(*) as cnt FROM flows WHERE (application IS NULL OR application IN ('Unknown','')) AND start_time >= NOW() - INTERVAL 1 DAY"),
      query(`
        SELECT COALESCE(am.category, 'Unclassified') AS category,
               COUNT(*) AS flows,
               SUM(f.total_bytes) AS bytes
        FROM flows f
        LEFT JOIN (
          SELECT application, MIN(category) AS category
          FROM application_mappings GROUP BY application
        ) am ON am.application = f.application
        WHERE f.start_time >= NOW() - INTERVAL 1 DAY
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

// GET /api/stats/app-usage  — application usage broken down by source IP
// Returns rows: { src_ip, application, category, flows, total_bytes, total_packets, subscriber_id, subscriber_name }
router.get('/app-usage', requireAuth, async (req, res) => {
  try {
    const { where, vals } = timeRange(req.query);
    const limit = Math.min(parseInt(req.query.limit || '200'), 1000);
    const rows = await query(
      `SELECT f.src_ip,
              COALESCE(s.subscriber_id, 'unknown') AS subscriber_id,
              COALESCE(s.name, '')                 AS subscriber_name,
              f.application,
              COALESCE(am.category, '')            AS category,
              COUNT(*)                             AS flows,
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
       LIMIT ?`,
      [...vals, limit]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
