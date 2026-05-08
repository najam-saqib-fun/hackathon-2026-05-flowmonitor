require('dotenv').config();
const { getPool } = require('../src/db');
const { app } = require('../src/app');

// Warm DB pool on cold start (best-effort; errors surface per-request via health route)
getPool().catch(() => {});

module.exports = app;
