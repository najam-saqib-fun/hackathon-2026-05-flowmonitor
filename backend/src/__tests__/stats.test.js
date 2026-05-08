'use strict';

// Mock logger first — before any other require
jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// Mock analytics to avoid PostHog side effects
jest.mock('../analytics', () => ({
  track: jest.fn(),
  trackApiCall: jest.fn(),
  shutdown: jest.fn().mockResolvedValue(undefined),
}));

// Mock db — key: query must be a jest.fn() so each test can control return values
const mockQuery = jest.fn();
jest.mock('../db', () => ({
  getPool: jest.fn().mockResolvedValue({}),
  query: mockQuery,
  queryOne: jest.fn(),
}));

const request  = require('supertest');
const { signToken } = require('../auth');
const { app } = require('../app');

// Generate a valid auth token used across all stats tests
const token = signToken({ id: 1, username: 'admin', role: 'admin' });
const authHeader = `Bearer ${token}`;

afterEach(() => {
  mockQuery.mockReset();
});

// ── /api/stats/overview ─────────────────────────────────────────────────────

describe('GET /api/stats/overview', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/stats/overview');
    expect(res.status).toBe(401);
  });

  it('returns 200 with correct shape', async () => {
    // overview calls query() 3 times via Promise.all
    mockQuery
      .mockResolvedValueOnce([{
        total_flows: 100,
        total_bytes: 500000,
        total_packets: 1200,
        avg_duration_ms: 250,
        unique_src_ips: 20,
        unique_dst_ips: 40,
        unique_apps: 8,
      }])
      .mockResolvedValueOnce([
        { protocol: 6, flows: 80, bytes: 400000 },
        { protocol: 17, flows: 20, bytes: 100000 },
      ])
      .mockResolvedValueOnce([{ flows_last_60s: 5, bytes_last_60s: 25000 }]);

    const res = await request(app)
      .get('/api/stats/overview')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total_flows: 100,
      total_bytes: 500000,
      total_packets: 1200,
      avg_duration_ms: 250,
      unique_src_ips: 20,
      unique_dst_ips: 40,
      unique_apps: 8,
      flows_last_60s: 5,
      bytes_last_60s: 25000,
    });
    expect(Array.isArray(res.body.protocol_distribution)).toBe(true);
    expect(res.body.protocol_distribution).toHaveLength(2);
    // Protocol 6 → TCP
    const tcp = res.body.protocol_distribution.find(p => p.protocol === 6);
    expect(tcp.name).toBe('TCP');
    expect(tcp.flows).toBe(80);
  });

  it('returns 500 when db.query throws', async () => {
    mockQuery.mockRejectedValue(new Error('DB gone'));
    const res = await request(app)
      .get('/api/stats/overview')
      .set('Authorization', authHeader);
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
  });

  it('maps protocol numbers to human-readable names', async () => {
    mockQuery
      .mockResolvedValueOnce([{ total_flows: 10, total_bytes: 1000, total_packets: 50,
                                avg_duration_ms: 100, unique_src_ips: 2, unique_dst_ips: 3, unique_apps: 1 }])
      .mockResolvedValueOnce([
        { protocol: 17, flows: 5, bytes: 500 },
        { protocol: 1, flows: 2, bytes: 100 },
        { protocol: 999, flows: 1, bytes: 50 },
      ])
      .mockResolvedValueOnce([{ flows_last_60s: 0, bytes_last_60s: 0 }]);

    const res = await request(app)
      .get('/api/stats/overview')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    const dist = res.body.protocol_distribution;
    expect(dist.find(p => p.protocol === 17).name).toBe('UDP');
    expect(dist.find(p => p.protocol === 1).name).toBe('ICMP');
    expect(dist.find(p => p.protocol === 999).name).toBe('Proto-999');
  });
});

// ── /api/stats/top-apps ─────────────────────────────────────────────────────

describe('GET /api/stats/top-apps', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/stats/top-apps');
    expect(res.status).toBe(401);
  });

  it('returns 200 with an array', async () => {
    const fakeApps = [
      { application: 'YouTube', category: 'Video', total_flows: 50,
        total_bytes_sent: 100000, total_bytes_recv: 900000,
        total_bytes: 1000000, total_packets_sent: 1000, total_packets_recv: 9000,
        first_seen: '2024-01-01', last_seen: '2024-01-02' },
      { application: 'Zoom', category: 'VoIP', total_flows: 10,
        total_bytes_sent: 50000, total_bytes_recv: 50000,
        total_bytes: 100000, total_packets_sent: 500, total_packets_recv: 500,
        first_seen: '2024-01-01', last_seen: '2024-01-02' },
    ];
    mockQuery.mockResolvedValueOnce(fakeApps);

    const res = await request(app)
      .get('/api/stats/top-apps')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].application).toBe('YouTube');
    expect(res.body[0]).toHaveProperty('total_bytes');
    expect(res.body[0]).toHaveProperty('category');
  });

  it('returns empty array when no apps found', async () => {
    mockQuery.mockResolvedValueOnce([]);
    const res = await request(app)
      .get('/api/stats/top-apps')
      .set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('respects limit query param (max 100)', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await request(app)
      .get('/api/stats/top-apps?limit=5')
      .set('Authorization', authHeader);
    // Check the query was called with limit=5
    const callArgs = mockQuery.mock.calls[0];
    expect(callArgs[1]).toContain(5);
  });

  it('caps limit at 100 even when requesting more', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await request(app)
      .get('/api/stats/top-apps?limit=9999')
      .set('Authorization', authHeader);
    const callArgs = mockQuery.mock.calls[0];
    expect(callArgs[1]).toContain(100);
  });

  it('returns 500 when db.query throws', async () => {
    mockQuery.mockRejectedValue(new Error('DB error'));
    const res = await request(app)
      .get('/api/stats/top-apps')
      .set('Authorization', authHeader);
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
  });
});

// ── /api/stats/bandwidth ─────────────────────────────────────────────────────

describe('GET /api/stats/bandwidth', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/stats/bandwidth');
    expect(res.status).toBe(401);
  });

  it('returns 200 with array of time-series buckets', async () => {
    const fakeBandwidth = [
      { bucket: '2024-01-01 10:00:00', flows: 12, bytes: 60000, bytes_sent: 30000, bytes_recv: 30000 },
      { bucket: '2024-01-01 10:01:00', flows: 8,  bytes: 40000, bytes_sent: 20000, bytes_recv: 20000 },
    ];
    mockQuery.mockResolvedValueOnce(fakeBandwidth);

    const res = await request(app)
      .get('/api/stats/bandwidth')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({
      bucket: expect.any(String),
      flows: expect.any(Number),
      bytes: expect.any(Number),
    });
  });

  it('returns empty array when no bandwidth data exists', async () => {
    mockQuery.mockResolvedValueOnce([]);
    const res = await request(app)
      .get('/api/stats/bandwidth')
      .set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns 500 when db.query throws', async () => {
    mockQuery.mockRejectedValue(new Error('DB error'));
    const res = await request(app)
      .get('/api/stats/bandwidth')
      .set('Authorization', authHeader);
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
  });
});

// ── /api/stats/top-talkers ──────────────────────────────────────────────────

describe('GET /api/stats/top-talkers', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/stats/top-talkers');
    expect(res.status).toBe(401);
  });

  it('returns 200 with sources and destinations arrays', async () => {
    const fakeSources = [
      { ip: '192.168.1.1', flows: 50, bytes_sent: 100000, bytes_recv: 500000, total_bytes: 600000,
        subscriber_id: 'sub-001', subscriber_name: 'Alice' },
    ];
    const fakeDests = [
      { ip: '8.8.8.8', flows: 30, bytes_recv: 200000, bytes_sent: 50000, total_bytes: 250000 },
    ];
    mockQuery
      .mockResolvedValueOnce(fakeSources)
      .mockResolvedValueOnce(fakeDests);

    const res = await request(app)
      .get('/api/stats/top-talkers')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('sources');
    expect(res.body).toHaveProperty('destinations');
    expect(Array.isArray(res.body.sources)).toBe(true);
    expect(Array.isArray(res.body.destinations)).toBe(true);
    expect(res.body.sources[0].ip).toBe('192.168.1.1');
    expect(res.body.destinations[0].ip).toBe('8.8.8.8');
  });
});
