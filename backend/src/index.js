require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { getPool } = require('./db');
const { createWsServer } = require('./websocket');

const authRoutes        = require('./routes/auth');
const flowRoutes        = require('./routes/flows');
const statsRoutes       = require('./routes/stats');
const alertRoutes       = require('./routes/alerts');
const domainsRoutes     = require('./routes/domains');
const mappingsRoutes    = require('./routes/mappings');
const subscribersRoutes = require('./routes/subscribers');
const ipdrRoutes        = require('./routes/ipdr');
const policyRoutes      = require('./routes/policy');

const app = express();
const server = http.createServer(app);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'] }));
app.use(express.json());

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
app.use('/api/policy',     policyRoutes);

// API index
app.get('/api', (_req, res) => {
  res.json({
    name: 'FlowMon API',
    version: '1.0.0',
    endpoints: {
      auth:   ['POST /api/auth/login', 'GET /api/auth/me', 'GET /api/auth/users', 'POST /api/auth/users'],
      flows:  ['GET /api/flows', 'GET /api/flows/live', 'GET /api/flows/:id'],
      stats:  ['GET /api/stats/overview', 'GET /api/stats/top-apps', 'GET /api/stats/top-talkers',
               'GET /api/stats/bandwidth', 'GET /api/stats/protocol-distribution',
               'GET /api/stats/anomalies', 'GET /api/stats/history', 'GET /api/stats/app-detection'],
      alerts: ['GET /api/alerts/rules', 'POST /api/alerts/rules', 'PUT /api/alerts/rules/:id',
               'DELETE /api/alerts/rules/:id', 'GET /api/alerts/events',
               'POST /api/alerts/events/:id/acknowledge'],
      domains:     ['GET /api/domains', 'GET /api/domains/chart', 'GET /api/domains/unique-sources'],
      mappings:    ['GET /api/mappings', 'POST /api/mappings', 'PUT /api/mappings/:id', 'DELETE /api/mappings/:id',
                    'POST /api/mappings/import', 'GET /api/mappings/export'],
      subscribers: ['GET /api/subscribers', 'POST /api/subscribers', 'PUT /api/subscribers/:id',
                    'DELETE /api/subscribers/:id', 'POST /api/subscribers/import', 'GET /api/subscribers/export'],
      ipdr:        ['GET /api/ipdr', 'GET /api/ipdr/:id/flows'],
      misc:        ['GET /api/health'],
      ws:     'ws://<host>/ws?token=<jwt>',
    },
  });
});

// Health check
app.get('/api/health', async (_req, res) => {
  try {
    await getPool();
    res.json({ status: 'ok', ts: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
  }
});

// 404 handler
app.use((_req, res) => res.status(404).json({ error: 'Not found', hint: 'Visit GET /api for a list of endpoints' }));

// Error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const PORT = parseInt(process.env.PORT || '3000');

// Initialize DB, then start HTTP + WS server
getPool()
  .then(() => {
    createWsServer(server);
    server.listen(PORT, () => {
      console.log(`[server] HTTP + WebSocket listening on port ${PORT}`);
      console.log(`[server] REST API:    http://localhost:${PORT}/api`);
      console.log(`[server] WebSocket:   ws://localhost:${PORT}/ws?token=<jwt>`);
    });
  })
  .catch((err) => {
    console.error('[server] Failed to connect to DB:', err.message);
    process.exit(1);
  });
