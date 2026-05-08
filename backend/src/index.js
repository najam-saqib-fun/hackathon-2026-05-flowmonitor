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

getPool()
  .then(() => {
    createWsServer(server);
    server.listen(PORT, () => {
      logger.info('FlowMon API started', {
        port: PORT,
        rest: `http://localhost:${PORT}/api`,
        ws: `ws://localhost:${PORT}/ws?token=<jwt>`,
      });
    });
  })
  .catch((err) => {
    logger.error('Failed to connect to database — aborting startup', { err: err.message });
    process.exit(1);
  });

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down gracefully');
  await analytics.shutdown();
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});
