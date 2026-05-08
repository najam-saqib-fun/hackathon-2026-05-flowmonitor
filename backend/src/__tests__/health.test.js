'use strict';

// Mock logger first
jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// Mock analytics
jest.mock('../analytics', () => ({
  track: jest.fn(),
  trackApiCall: jest.fn(),
  shutdown: jest.fn().mockResolvedValue(undefined),
}));

// Mock db
const mockQuery   = jest.fn();
const mockGetPool = jest.fn();
jest.mock('../db', () => ({
  getPool: mockGetPool,
  query: mockQuery,
  queryOne: jest.fn(),
}));

const request = require('supertest');
const { app } = require('../app');

afterEach(() => {
  mockQuery.mockReset();
  mockGetPool.mockReset();
});

// ── GET /api/health ──────────────────────────────────────────────────────────

describe('GET /api/health', () => {
  it('returns 200 with status ok when DB is healthy', async () => {
    mockGetPool.mockResolvedValue({});

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok' });
  });

  it('response includes ts, uptime_s, and node_version fields', async () => {
    mockGetPool.mockResolvedValue({});

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ts');
    expect(res.body).toHaveProperty('uptime_s');
    expect(res.body).toHaveProperty('node_version');
    expect(typeof res.body.ts).toBe('string');
    expect(typeof res.body.uptime_s).toBe('number');
    expect(typeof res.body.node_version).toBe('string');
  });

  it('ts field is a valid ISO-8601 date', async () => {
    mockGetPool.mockResolvedValue({});

    const res = await request(app).get('/api/health');

    expect(new Date(res.body.ts).toISOString()).toBe(res.body.ts);
  });

  it('returns 503 with status error when DB is unavailable', async () => {
    mockGetPool.mockRejectedValue(new Error('Connection refused'));

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'error' });
    expect(res.body).toHaveProperty('error');
  });

  it('health endpoint is accessible without authentication', async () => {
    mockGetPool.mockResolvedValue({});

    // No Authorization header
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });
});

// ── GET /api/admin/metrics ───────────────────────────────────────────────────

describe('GET /api/admin/metrics', () => {
  function setupMetricsDb() {
    mockGetPool.mockResolvedValue({});
    mockQuery
      .mockResolvedValueOnce([{ total_flows: 500, total_bytes: 2000000, unique_ips: 30, unique_apps: 12 }])  // flowStats
      .mockResolvedValueOnce([{ total: 5 }])   // alertCount
      .mockResolvedValueOnce([{ total: 20 }])  // mappingCount
      .mockResolvedValueOnce([{ total: 10 }]); // subscriberCount
  }

  it('returns 200 with correct metrics shape', async () => {
    setupMetricsDb();

    const res = await request(app).get('/api/admin/metrics');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ts');
    expect(res.body).toHaveProperty('process');
    expect(res.body).toHaveProperty('database');
    expect(res.body).toHaveProperty('config');
  });

  it('process block contains required fields', async () => {
    setupMetricsDb();

    const res = await request(app).get('/api/admin/metrics');

    expect(res.status).toBe(200);
    expect(res.body.process).toMatchObject({
      uptime_s: expect.any(Number),
      mem_rss_mb: expect.any(Number),
      node_version: expect.any(String),
      hostname: expect.any(String),
    });
  });

  it('database block reflects mocked db query results', async () => {
    setupMetricsDb();

    const res = await request(app).get('/api/admin/metrics');

    expect(res.status).toBe(200);
    expect(res.body.database).toMatchObject({
      total_flows: 500,
      total_bytes: 2000000,
      unique_ips: 30,
      unique_apps: 12,
      alert_rules: 5,
      app_mappings: 20,
      subscribers: 10,
    });
  });

  it('config block contains expected config keys', async () => {
    setupMetricsDb();

    const res = await request(app).get('/api/admin/metrics');

    expect(res.status).toBe(200);
    expect(res.body.config).toHaveProperty('ws_push_interval_ms');
    expect(res.body.config).toHaveProperty('sentry_enabled');
    expect(res.body.config).toHaveProperty('analytics_enabled');
    expect(res.body.config).toHaveProperty('geoip_enabled');
    expect(typeof res.body.config.ws_push_interval_ms).toBe('number');
    expect(typeof res.body.config.sentry_enabled).toBe('boolean');
  });

  it('returns 500 when db.query throws', async () => {
    mockQuery.mockRejectedValue(new Error('DB failure'));

    const res = await request(app).get('/api/admin/metrics');

    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
  });

  it('admin/metrics endpoint is accessible without authentication (no auth guard)', async () => {
    setupMetricsDb();
    // Should return 200 — this route has no requireAuth guard
    const res = await request(app).get('/api/admin/metrics');
    expect(res.status).toBe(200);
  });
});

// ── GET /api (API index) ─────────────────────────────────────────────────────

describe('GET /api', () => {
  it('returns 200 with name FlowMon API', async () => {
    const res = await request(app).get('/api');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('FlowMon API');
    expect(res.body).toHaveProperty('endpoints');
  });
});

// ── 404 handler ──────────────────────────────────────────────────────────────

describe('Unknown routes', () => {
  it('returns 404 for a completely unknown route', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
  });
});
