require('dotenv').config();
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
