// Load environment-specific config first (.env.production / .env.development),
// then fall back to .env for any unset vars.
const NODE_ENV = process.env.NODE_ENV || 'development';
require('dotenv').config({ path: `.env.${NODE_ENV}` });
require('dotenv').config(); // fallback
const logger    = require('./logger');
const analytics = require('./analytics');
const { getPool } = require('./db');
const { createWsServer } = require('./websocket');
const { app, server } = require('./app');

const PORT = parseInt(process.env.PORT || '3000');

// Start HTTP server immediately so the healthcheck passes on Railway/Vercel.
// DB connection happens asynchronously in the background with retries.
server.listen(PORT, () => {
  logger.info('FlowMon API started', {
    port: PORT,
    rest: `http://localhost:${PORT}/api`,
    ws: `ws://localhost:${PORT}/ws?token=<jwt>`,
  });
});

async function initDb(attempt = 1) {
  try {
    await getPool();
    createWsServer(server);
    logger.info('Database connected and WebSocket server ready');
  } catch (err) {
    const delay = Math.min(5000 * attempt, 60000);
    logger.error('Database connection failed — retrying', { attempt, delay_ms: delay, err: err.message });
    setTimeout(() => initDb(attempt + 1), delay);
  }
}
initDb();

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down gracefully');
  await analytics.shutdown();
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});

