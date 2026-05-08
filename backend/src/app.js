require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const os = require('os');

const logger    = require('./logger');
const analytics = require('./analytics');
const { getPool, query } = require('./db');

// Sentry — enabled only when SENTRY_DSN is set in environment
let Sentry = null;
if (process.env.SENTRY_DSN) {
  try {
    Sentry = require('@sentry/node');
    Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.2 });
    logger.info('Sentry error tracking enabled');
  } catch (err) {
    logger.warn('Sentry init failed — error tracking disabled', { err: err.message });
  }
}

const authRoutes        = require('./routes/auth');
const flowRoutes        = require('./routes/flows');
const statsRoutes       = require('./routes/stats');
const alertRoutes       = require('./routes/alerts');
const domainsRoutes     = require('./routes/domains');
const mappingsRoutes    = require('./routes/mappings');
const subscribersRoutes = require('./routes/subscribers');
const ipdrRoutes        = require('./routes/ipdr');
const policyRoutes      = require('./routes/policy');

const app    = express();
const server = http.createServer(app);

if (Sentry) app.use(Sentry.Handlers.requestHandler());

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));
app.use(express.json());

// Request timing middleware for analytics
app.use((req, _res, next) => {
  req._startMs = Date.now();
  next();
});

// Rate-limit login endpoint
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));

app.use('/api/auth',        authRoutes);
app.use('/api/flows',       flowRoutes);
app.use('/api/stats',       statsRoutes);
app.use('/api/alerts',      alertRoutes);
app.use('/api/domains',     domainsRoutes);
app.use('/api/mappings',    mappingsRoutes);
app.use('/api/subscribers', subscribersRoutes);
app.use('/api/ipdr',        ipdrRoutes);
app.use('/api/policy',      policyRoutes);

// API index
app.get('/api', (_req, res) => {
  res.json({
    name: 'FlowMon API',
    version: '1.0.0',
    endpoints: {
      auth:        ['POST /api/auth/login', 'GET /api/auth/me', 'GET /api/auth/users', 'POST /api/auth/users'],
      flows:       ['GET /api/flows', 'GET /api/flows/live', 'GET /api/flows/:id'],
      stats:       ['GET /api/stats/overview', 'GET /api/stats/top-apps', 'GET /api/stats/top-talkers',
                    'GET /api/stats/bandwidth', 'GET /api/stats/protocol-distribution',
                    'GET /api/stats/anomalies', 'GET /api/stats/history', 'GET /api/stats/app-detection'],
      alerts:      ['GET /api/alerts/rules', 'POST /api/alerts/rules', 'PUT /api/alerts/rules/:id',
                    'DELETE /api/alerts/rules/:id', 'GET /api/alerts/events',
                    'POST /api/alerts/events/:id/acknowledge'],
      domains:     ['GET /api/domains', 'GET /api/domains/chart', 'GET /api/domains/unique-sources'],
      mappings:    ['GET /api/mappings', 'POST /api/mappings', 'PUT /api/mappings/:id', 'DELETE /api/mappings/:id',
                    'POST /api/mappings/import', 'GET /api/mappings/export', 'GET /api/mappings/applications'],
      subscribers: ['GET /api/subscribers', 'POST /api/subscribers', 'PUT /api/subscribers/:id',
                    'DELETE /api/subscribers/:id', 'POST /api/subscribers/import', 'GET /api/subscribers/export'],
      ipdr:        ['GET /api/ipdr', 'GET /api/ipdr/:id/flows'],
      policy:      ['GET /api/policy', 'PUT /api/policy/:application', 'POST /api/policy/bulk'],
      admin:       ['GET /api/admin/metrics'],
      misc:        ['GET /api/health'],
      ws:          'ws://<host>/ws?token=<jwt>',
    },
  });
});

// Health check — DB ping + uptime
app.get('/api/health', async (_req, res) => {
  try {
    await getPool();
    res.json({
      status: 'ok',
      ts: new Date().toISOString(),
      uptime_s: Math.floor(process.uptime()),
      node_version: process.version,
    });
  } catch (err) {
    logger.error('Health check failed', { err: err.message });
    res.status(503).json({ status: 'error', error: err.message });
  }
});

// Admin metrics — system stats for operators
app.get('/api/admin/metrics', async (_req, res) => {
  try {
    const [flowStats, alertCount, mappingCount, subscriberCount] = await Promise.all([
      query(`SELECT COUNT(*) AS total_flows,
                    COALESCE(SUM(total_bytes), 0) AS total_bytes,
                    COUNT(DISTINCT src_ip) AS unique_ips,
                    COUNT(DISTINCT application) AS unique_apps
             FROM flows`),
      query(`SELECT COUNT(*) AS total FROM alert_rules`),
      query(`SELECT COUNT(*) AS total FROM application_mappings`),
      query(`SELECT COUNT(*) AS total FROM subscribers`),
    ]);

    res.json({
      ts: new Date().toISOString(),
      process: {
        uptime_s: Math.floor(process.uptime()),
        mem_rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        node_version: process.version,
        hostname: os.hostname(),
      },
      database: {
        ...flowStats[0],
        alert_rules: alertCount[0].total,
        app_mappings: mappingCount[0].total,
        subscribers: subscriberCount[0].total,
      },
      config: {
        ws_push_interval_ms: parseInt(process.env.WS_PUSH_INTERVAL_MS || '15000'),
        sentry_enabled: !!Sentry,
        analytics_enabled: !!(process.env.POSTHOG_API_KEY),
        geoip_enabled: !!(process.env.GEOIP_DB_PATH),
      },
    });
  } catch (err) {
    logger.error('Admin metrics failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

if (Sentry) app.use(Sentry.Handlers.errorHandler());

// 404 handler
app.use((_req, res) =>
  res.status(404).json({ error: 'Not found', hint: 'Visit GET /api for a list of endpoints' })
);

// Global error handler
app.use((err, req, _res_unused, res) => {
  const durationMs = req._startMs ? Date.now() - req._startMs : null;
  logger.error('Unhandled request error', {
    method: req.method,
    path: req.path,
    durationMs,
    err: err.message,
    stack: err.stack,
  });
  analytics.trackApiCall(req.path, req.method, req.user?.id, durationMs, 500);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = { app, server };
