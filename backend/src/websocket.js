const WebSocket = require('ws');
const { verifyToken } = require('./auth');
const { query } = require('./db');

const PUSH_INTERVAL_MS = parseInt(process.env.WS_PUSH_INTERVAL_MS || '3000');

function createWsServer(server) {
  const wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    // Auth via query param: ws://host/ws?token=<jwt>
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
              WHERE f.updated_at >= NOW() - INTERVAL 30 SECOND
              ORDER BY f.updated_at DESC
              LIMIT 100
            `),
            query(`
              SELECT COUNT(*) as total_flows,
                     COALESCE(SUM(total_bytes), 0) as total_bytes,
                     COALESCE(SUM(total_packets), 0) as total_packets,
                     COUNT(DISTINCT src_ip) as unique_src_ips,
                     COUNT(DISTINCT application) as unique_apps,
                     (SELECT COUNT(*) FROM flows WHERE updated_at >= NOW() - INTERVAL 60 SECOND) as flows_last_60s,
                     (SELECT COALESCE(SUM(total_bytes), 0) FROM flows WHERE updated_at >= NOW() - INTERVAL 60 SECOND) as bytes_last_60s
              FROM flows
              WHERE start_time >= NOW() - INTERVAL 1 HOUR
            `),
            query(`
              SELECT application, SUM(total_bytes) as bytes, COUNT(*) as flows
              FROM flows
              WHERE start_time >= NOW() - INTERVAL 5 MINUTE
              GROUP BY application
              ORDER BY bytes DESC
              LIMIT 10
            `),
            query(`
              SELECT src_ip as ip, SUM(total_bytes) as bytes, COUNT(*) as flows
              FROM flows
              WHERE start_time >= NOW() - INTERVAL 5 MINUTE
              GROUP BY src_ip
              ORDER BY bytes DESC
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
          console.error('[ws] push error:', err.message);
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

    ws.on('close', () => {
      clearInterval(pushTimer);
    });

    // Auto-start push on connect
    startPush();
  });

  // Heartbeat to detect broken connections
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) { ws.terminate(); return; }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => clearInterval(heartbeat));

  // Alert checker — runs every 30s, fires alert_events for triggered rules
  setInterval(async () => {
    try {
      const rules = await query('SELECT * FROM alert_rules WHERE enabled = 1');
      for (const rule of rules) {
        let value = 0;
        let triggered = false;
        const win = rule.window_seconds || 60;

        if (rule.metric === 'bytes_per_sec') {
          const whereApp  = rule.application ? 'AND application = ?' : '';
          const whereSrc  = rule.src_ip ? 'AND src_ip = ?' : '';
          const params = [win];
          if (rule.application) params.push(rule.application);
          if (rule.src_ip) params.push(rule.src_ip);
          const [row] = await query(
            `SELECT COALESCE(SUM(total_bytes), 0) / ? as val
             FROM flows
             WHERE start_time >= NOW() - INTERVAL ? SECOND ${whereApp} ${whereSrc}`,
            [win, ...params]
          );
          value = row?.val || 0;
          triggered = value > rule.threshold;

        } else if (rule.metric === 'flows_per_min') {
          const [row] = await query(
            `SELECT COUNT(*) / (? / 60.0) as val
             FROM flows WHERE start_time >= NOW() - INTERVAL ? SECOND`,
            [win, win]
          );
          value = row?.val || 0;
          triggered = value > rule.threshold;

        } else if (rule.metric === 'conn_per_ip') {
          const [row] = await query(
            `SELECT MAX(cnt) as val FROM (
               SELECT src_ip, COUNT(*) as cnt
               FROM flows WHERE start_time >= NOW() - INTERVAL ? SECOND
               GROUP BY src_ip
             ) t`,
            [win]
          );
          value = row?.val || 0;
          triggered = value > rule.threshold;
        }

        if (triggered) {
          await query(
            'INSERT INTO alert_events (rule_id, metric_value, details) VALUES (?, ?, ?)',
            [rule.id, value, JSON.stringify({ rule_name: rule.name, threshold: rule.threshold })]
          );
          // Broadcast to all connected WS clients
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
      console.error('[ws] alert check error:', err.message);
    }
  }, 30000);

  console.log(`[ws] WebSocket server ready on /ws`);
  return wss;
}

module.exports = { createWsServer };
