const WebSocket = require('ws');
const { verifyToken } = require('./auth');
const { query } = require('./db');
const logger = require('./logger');
const analytics = require('./analytics');

const PUSH_INTERVAL_MS = parseInt(process.env.WS_PUSH_INTERVAL_MS || '15000');

function createWsServer(server) {
  const wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    let user;
    try {
      user = verifyToken(token);
    } catch {
      ws.close(1008, 'Unauthorized');
      return;
    }

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    let pushTimer = null;

    function startPush() {
      pushTimer = setInterval(async () => {
        if (ws.readyState !== WebSocket.OPEN) {
          clearInterval(pushTimer);
          return;
        }
        try {
          const [liveFlows, overview, topApps, topTalkers] = await Promise.all([
            query(`
              SELECT f.id, f.src_ip, f.dst_ip, f.src_port, f.dst_port, f.protocol,
                     f.application, COALESCE(am.category, '') AS application_category,
                     f.hostnames,
                     f.bytes_sent, f.bytes_recv, f.total_bytes, f.total_packets,
                     f.start_time, f.updated_at
              FROM flows f
              LEFT JOIN (
                SELECT application, MIN(category) AS category
                FROM application_mappings GROUP BY application
              ) am ON am.application = f.application
              WHERE f.updated_at >= NOW() - INTERVAL '30 seconds'
              ORDER BY f.updated_at DESC
              LIMIT 100
            `),
            query(`
              SELECT COUNT(*)::int                AS total_flows,
                     COALESCE(SUM(total_bytes),0) AS total_bytes,
                     COALESCE(SUM(total_packets),0) AS total_packets,
                     COUNT(DISTINCT src_ip)::int  AS unique_src_ips,
                     COUNT(DISTINCT application)::int AS unique_apps,
                     (SELECT COUNT(*)::int FROM flows WHERE updated_at >= NOW() - INTERVAL '60 seconds') AS flows_last_60s,
                     (SELECT COALESCE(SUM(total_bytes),0) FROM flows WHERE updated_at >= NOW() - INTERVAL '60 seconds') AS bytes_last_60s
              FROM flows
            `),
            query(`
              SELECT a.application,
                     COALESCE(am.category, a.category, '') AS category,
                     a.total_flows AS flows,
                     (a.total_bytes_sent + a.total_bytes_recv) AS total_bytes
              FROM applications_summary a
              LEFT JOIN (
                SELECT application, MIN(category) AS category
                FROM application_mappings GROUP BY application
              ) am ON am.application = a.application
              ORDER BY total_bytes DESC
              LIMIT 10
            `),
            query(`
              SELECT f.src_ip                            AS ip,
                     SUM(f.total_bytes)                 AS total_bytes,
                     COUNT(*)::int                      AS flows,
                     COALESCE(s.subscriber_id,'unknown') AS subscriber_id,
                     COALESCE(s.name,'')                AS subscriber_name
              FROM flows f
              LEFT JOIN subscribers s ON s.ip_address = f.src_ip
              GROUP BY f.src_ip, s.subscriber_id, s.name
              ORDER BY total_bytes DESC
              LIMIT 10
            `),
          ]);

          const payload = JSON.stringify({
            type: 'live_update',
            ts: Date.now(),
            data: {
              live_flows: liveFlows,
              overview: overview[0],
              top_apps: topApps,
              top_talkers: topTalkers,
            },
          });
          ws.send(payload);
        } catch (err) {
          logger.error('WS push error', { err: err.message });
        }
      }, PUSH_INTERVAL_MS);
    }

    ws.on('message', (msg) => {
      try {
        const data = JSON.parse(msg);
        if (data.type === 'subscribe') {
          if (!pushTimer) startPush();
        } else if (data.type === 'unsubscribe') {
          clearInterval(pushTimer);
          pushTimer = null;
        }
      } catch {}
    });

    ws.on('close', () => { clearInterval(pushTimer); });

    startPush();
  });

  // Heartbeat
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) { ws.terminate(); return; }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => clearInterval(heartbeat));

  // Alert checker — every 30 s
  setInterval(async () => {
    try {
      const rules = await query('SELECT * FROM alert_rules WHERE enabled = TRUE');
      for (const rule of rules) {
        let value = 0;
        let triggered = false;
        const win = rule.window_seconds || 60;

        if (rule.metric === 'bytes_per_sec') {
          const whereApp = rule.application ? 'AND application = $3' : '';
          const whereSrc = rule.src_ip      ? `AND src_ip = $${rule.application ? 4 : 3}` : '';
          const params = [win, win];
          if (rule.application) params.push(rule.application);
          if (rule.src_ip)      params.push(rule.src_ip);
          const rows = await query(
            `SELECT COALESCE(SUM(total_bytes), 0)::float / $1 AS val
             FROM flows
             WHERE start_time >= NOW() - ($2 * INTERVAL '1 second') ${whereApp} ${whereSrc}`,
            params
          );
          value = parseFloat(rows[0]?.val || 0);
          triggered = value > rule.threshold;

        } else if (rule.metric === 'flows_per_min') {
          const rows = await query(
            `SELECT COUNT(*)::float / ($1 / 60.0) AS val
             FROM flows WHERE start_time >= NOW() - ($2 * INTERVAL '1 second')`,
            [win, win]
          );
          value = parseFloat(rows[0]?.val || 0);
          triggered = value > rule.threshold;

        } else if (rule.metric === 'conn_per_ip') {
          const rows = await query(
            `SELECT MAX(cnt)::int AS val FROM (
               SELECT src_ip, COUNT(*)::int AS cnt
               FROM flows WHERE start_time >= NOW() - ($1 * INTERVAL '1 second')
               GROUP BY src_ip
             ) t`,
            [win]
          );
          value = rows[0]?.val || 0;
          triggered = value > rule.threshold;

        } else if (rule.metric === 'unusual_port') {
          const rows = await query(
            `SELECT COUNT(*)::int AS val
             FROM flows
             WHERE start_time >= NOW() - ($1 * INTERVAL '1 second')
               AND dst_port NOT IN (
                 20,21,22,23,25,53,67,68,80,110,143,161,443,465,587,
                 993,995,3306,3389,5432,8080,8443
               )
               AND dst_port > $2`,
            [win, rule.threshold]
          );
          value = rows[0]?.val || 0;
          triggered = value > 0;
        }

        if (triggered) {
          await query(
            'INSERT INTO alert_events (rule_id, metric_value, details) VALUES ($1, $2, $3)',
            [rule.id, value, JSON.stringify({ rule_name: rule.name, threshold: rule.threshold })]
          );
          analytics.track('alert_triggered', 'system', {
            rule_id: rule.id, rule_name: rule.name,
            metric: rule.metric, value, threshold: rule.threshold,
          });
          const alertMsg = JSON.stringify({
            type: 'alert',
            ts: Date.now(),
            data: { rule_id: rule.id, rule_name: rule.name, metric: rule.metric, value, threshold: rule.threshold },
          });
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) client.send(alertMsg);
          });
        }
      }
    } catch (err) {
      logger.error('WS alert check error', { err: err.message });
    }
  }, 30000);

  logger.info('WebSocket server ready', { path: '/ws' });
  return wss;
}

module.exports = { createWsServer };
