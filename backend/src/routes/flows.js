const express = require('express');
const { query, queryOne } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const RAW_PROTOCOLS = new Set([
  'TLS','QUIC','HTTP','HTTPS','DNS','NTP','ICMP','DHCP',
  'SSH','FTP','SMTP','IMAP','POP3','RDP','VNC','BGP','SNMP',
  'HTTP_Proxy','SMTPS','IMAPS','POP3S','Telnet','NetBIOS',
  'NetBIOS.SMBv1','Unknown','',
]);

function isUnclassified(row) {
  return !row.application || RAW_PROTOCOLS.has(row.application) ||
    !row.application_category || row.application_category === 'Unspecified';
}

// Build a parameterised WHERE clause; returns { where, values, nextIdx }
function buildWhere(params, tablePrefix = '', startIdx = 1) {
  const p = tablePrefix ? `${tablePrefix}.` : '';
  const clauses = [];
  const values = [];
  let i = startIdx;

  if (params.start) { clauses.push(`${p}start_time >= $${i++}`); values.push(params.start); }
  if (params.end)   { clauses.push(`${p}end_time <= $${i++}`);   values.push(params.end); }
  if (params.application) { clauses.push(`${p}application LIKE $${i++}`); values.push(`%${params.application}%`); }
  if (params.category)    { clauses.push(`am.category = $${i++}`); values.push(params.category); }
  if (params.src_ip)  { clauses.push(`${p}src_ip = $${i++}`);  values.push(params.src_ip); }
  if (params.dst_ip)  { clauses.push(`${p}dst_ip = $${i++}`);  values.push(params.dst_ip); }
  if (params.ip)      {
    clauses.push(`(${p}src_ip = $${i} OR ${p}dst_ip = $${i+1})`);
    values.push(params.ip, params.ip);
    i += 2;
  }
  if (params.protocol !== undefined && params.protocol !== '') {
    clauses.push(`${p}protocol = $${i++}`); values.push(params.protocol);
  }
  if (params.src_port) { clauses.push(`${p}src_port = $${i++}`); values.push(params.src_port); }
  if (params.dst_port) { clauses.push(`${p}dst_port = $${i++}`); values.push(params.dst_port); }
  if (params.subscriber) {
    clauses.push(`s.subscriber_id LIKE $${i++}`); values.push(`%${params.subscriber}%`);
  }
  if (params.classified === 'true') {
    const rawList = [...RAW_PROTOCOLS].filter(Boolean);
    const placeholders = rawList.map(() => `$${i++}`).join(',');
    clauses.push(`(${p}application IS NOT NULL AND ${p}application NOT IN (${placeholders}) AND am.category IS NOT NULL AND am.category != 'Unspecified')`);
    values.push(...rawList);
  } else if (params.classified === 'false') {
    const rawList = [...RAW_PROTOCOLS].filter(Boolean);
    const placeholders = rawList.map(() => `$${i++}`).join(',');
    clauses.push(`(${p}application IS NULL OR ${p}application IN (${placeholders}) OR am.category IS NULL OR am.category = 'Unspecified')`);
    values.push(...rawList);
  }

  return { where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', values, nextIdx: i };
}

// GET /api/flows
router.get('/', requireAuth, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || '100'), 1000);
    const offset = parseInt(req.query.offset || '0');
    const validSorts = ['f.start_time','f.end_time','f.total_bytes','f.total_packets','f.flow_duration_ms'];
    const sortKey = req.query.sort ? `f.${req.query.sort}` : 'f.start_time';
    const sort  = validSorts.includes(sortKey) ? sortKey : 'f.start_time';
    const order = req.query.order === 'asc' ? 'ASC' : 'DESC';

    const { where, values, nextIdx } = buildWhere(req.query, 'f');

    const selectCols = `
      f.id, f.flow_hash, f.src_ip, f.dst_ip, f.src_port, f.dst_port, f.protocol,
      f.application, f.start_time, f.end_time,
      f.flow_duration_ms, f.packet_sent, f.packet_recv, f.bytes_sent, f.bytes_recv,
      f.total_packets, f.total_bytes, f.hostnames, f.urls, f.metadata, f.updated_at,
      COALESCE(s.subscriber_id, 'unknown') AS subscriber_id,
      COALESCE(s.name, '') AS subscriber_name,
      COALESCE(am.category, '') AS application_category`;

    const fromJoin = `FROM flows f
      LEFT JOIN subscribers s ON s.ip_address = f.src_ip
      LEFT JOIN (SELECT application, MIN(category) AS category FROM application_mappings GROUP BY application) am ON am.application = f.application`;

    const [rows, countRows] = await Promise.all([
      query(
        `SELECT ${selectCols} ${fromJoin} ${where} ORDER BY ${sort} ${order} LIMIT $${nextIdx} OFFSET $${nextIdx + 1}`,
        [...values, limit, offset]
      ),
      query(`SELECT COUNT(*)::int AS total ${fromJoin} ${where}`, values),
    ]);

    rows.forEach(r => {
      if (!r.application || RAW_PROTOCOLS.has(r.application)) r._unclassified = true;
    });

    res.json({ total: countRows[0].total, limit, offset, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/flows/live
router.get('/live', requireAuth, async (req, res) => {
  try {
    const seconds = Math.min(parseInt(req.query.seconds || '30'), 300);
    const rows = await query(
      `SELECT f.id, f.src_ip, f.dst_ip, f.src_port, f.dst_port, f.protocol,
              f.application, f.start_time, f.end_time,
              f.bytes_sent, f.bytes_recv, f.total_bytes, f.total_packets, f.updated_at,
              COALESCE(s.subscriber_id, 'unknown') AS subscriber_id,
              COALESCE(s.name, '') AS subscriber_name,
              COALESCE(am.category, '') AS application_category
       FROM flows f
       LEFT JOIN subscribers s ON s.ip_address = f.src_ip
       LEFT JOIN (SELECT application, MIN(category) AS category FROM application_mappings GROUP BY application) am ON am.application = f.application
       WHERE f.updated_at >= NOW() - ($1 * INTERVAL '1 second')
       ORDER BY f.updated_at DESC
       LIMIT 500`,
      [seconds]
    );
    rows.forEach(r => { r._unclassified = RAW_PROTOCOLS.has(r.application) || !r.application; });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/flows/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const flow = await queryOne(
      `SELECT f.*, f.ipdr_key_id,
              COALESCE(s.subscriber_id,'unknown') AS subscriber_id,
              COALESCE(s.name,'') AS subscriber_name
       FROM flows f LEFT JOIN subscribers s ON s.ip_address = f.src_ip
       WHERE f.id = $1`,
      [req.params.id]
    );
    if (!flow) return res.status(404).json({ error: 'Flow not found' });

    const [hostnames, urls] = await Promise.all([
      query('SELECT hostname, first_seen, last_seen, resolution_count FROM hostnames WHERE flow_id = $1', [flow.id]),
      query('SELECT url, host, path, protocol, first_seen, last_seen, access_count FROM urls WHERE flow_id = $1', [flow.id]),
    ]);

    flow._unclassified = RAW_PROTOCOLS.has(flow.application) || !flow.application;
    res.json({ ...flow, hostnames_detail: hostnames, urls_detail: urls });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
