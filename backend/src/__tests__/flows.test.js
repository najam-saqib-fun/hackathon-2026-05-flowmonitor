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
const mockQuery    = jest.fn();
const mockQueryOne = jest.fn();
jest.mock('../db', () => ({
  getPool: jest.fn().mockResolvedValue({}),
  query: mockQuery,
  queryOne: mockQueryOne,
}));

const request = require('supertest');
const { signToken } = require('../auth');
const { app } = require('../app');

const token = signToken({ id: 1, username: 'admin', role: 'admin' });
const authHeader = `Bearer ${token}`;

afterEach(() => {
  mockQuery.mockReset();
  mockQueryOne.mockReset();
});

// Helper to build a fake flow row
function fakeFlow(overrides = {}) {
  return {
    id: 1,
    flow_hash: 'abc123',
    src_ip: '10.0.0.1',
    dst_ip: '8.8.8.8',
    src_port: 54321,
    dst_port: 443,
    protocol: 6,
    application: 'YouTube',
    start_time: '2024-01-01T00:00:00',
    end_time: '2024-01-01T00:01:00',
    flow_duration_ms: 60000,
    packet_sent: 100,
    packet_recv: 80,
    bytes_sent: 50000,
    bytes_recv: 200000,
    total_packets: 180,
    total_bytes: 250000,
    hostnames: '["youtube.com"]',
    urls: '[]',
    metadata: '{}',
    updated_at: '2024-01-01T00:01:00',
    subscriber_id: 'sub-001',
    subscriber_name: 'Alice',
    application_category: 'Video',
    ...overrides,
  };
}

// ── GET /api/flows ───────────────────────────────────────────────────────────

describe('GET /api/flows', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/flows');
    expect(res.status).toBe(401);
  });

  it('returns 200 with rows and total when flows exist', async () => {
    const rows = [fakeFlow(), fakeFlow({ id: 2, src_ip: '10.0.0.2' })];
    mockQuery
      .mockResolvedValueOnce(rows)                 // SELECT rows
      .mockResolvedValueOnce([{ total: 2 }]);       // COUNT

    const res = await request(app)
      .get('/api/flows')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('rows');
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('limit');
    expect(res.body).toHaveProperty('offset');
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.total).toBe(2);
  });

  it('returns 200 with empty rows when no flows exist', async () => {
    mockQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0 }]);

    const res = await request(app)
      .get('/api/flows')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it('tags unclassified flows with _unclassified=true', async () => {
    const rows = [
      fakeFlow({ application: 'Unknown' }),
      fakeFlow({ id: 2, application: 'YouTube' }),
    ];
    mockQuery
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([{ total: 2 }]);

    const res = await request(app)
      .get('/api/flows')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.rows[0]._unclassified).toBe(true);
    expect(res.body.rows[1]._unclassified).toBeUndefined();
  });

  it('respects limit and offset query params', async () => {
    mockQuery
      .mockResolvedValueOnce([fakeFlow()])
      .mockResolvedValueOnce([{ total: 50 }]);

    const res = await request(app)
      .get('/api/flows?limit=1&offset=10')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(10);
  });

  it('caps limit at 1000', async () => {
    mockQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0 }]);

    const res = await request(app)
      .get('/api/flows?limit=99999')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(1000);
  });

  it('returns 500 when db.query throws', async () => {
    mockQuery.mockRejectedValue(new Error('DB gone'));
    const res = await request(app)
      .get('/api/flows')
      .set('Authorization', authHeader);
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
  });
});

// ── GET /api/flows/live ──────────────────────────────────────────────────────

describe('GET /api/flows/live', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/flows/live');
    expect(res.status).toBe(401);
  });

  it('returns 200 with an array of active flows', async () => {
    const liveRows = [
      fakeFlow({ updated_at: new Date().toISOString() }),
      fakeFlow({ id: 2, src_ip: '10.0.0.2', updated_at: new Date().toISOString() }),
    ];
    mockQuery.mockResolvedValueOnce(liveRows);

    const res = await request(app)
      .get('/api/flows/live')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
  });

  it('returns 200 with empty array when no live flows', async () => {
    mockQuery.mockResolvedValueOnce([]);

    const res = await request(app)
      .get('/api/flows/live')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('marks unclassified flows in live response', async () => {
    const liveRows = [
      fakeFlow({ application: '' }),   // empty application → unclassified
      fakeFlow({ id: 2, application: 'Netflix' }),
    ];
    mockQuery.mockResolvedValueOnce(liveRows);

    const res = await request(app)
      .get('/api/flows/live')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body[0]._unclassified).toBe(true);
    expect(res.body[1]._unclassified).toBe(false);
  });

  it('caps seconds at 300', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await request(app)
      .get('/api/flows/live?seconds=99999')
      .set('Authorization', authHeader);
    // Ensure query was called with capped value 300
    const callArgs = mockQuery.mock.calls[0];
    expect(callArgs[1]).toContain(300);
  });

  it('returns 500 when db.query throws', async () => {
    mockQuery.mockRejectedValue(new Error('DB gone'));
    const res = await request(app)
      .get('/api/flows/live')
      .set('Authorization', authHeader);
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
  });
});

// ── GET /api/flows/:id ───────────────────────────────────────────────────────

describe('GET /api/flows/:id', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/flows/1');
    expect(res.status).toBe(401);
  });

  it('returns 404 when flow does not exist', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await request(app)
      .get('/api/flows/9999')
      .set('Authorization', authHeader);

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 200 with flow details when found', async () => {
    const flow = fakeFlow({ id: 1 });
    mockQueryOne.mockResolvedValueOnce(flow);
    // hostnames and urls sub-queries
    mockQuery
      .mockResolvedValueOnce([{ hostname: 'youtube.com', first_seen: '2024-01-01', last_seen: '2024-01-01', resolution_count: 5 }])
      .mockResolvedValueOnce([]);

    const res = await request(app)
      .get('/api/flows/1')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(1);
    expect(res.body.src_ip).toBe('10.0.0.1');
    expect(Array.isArray(res.body.hostnames_detail)).toBe(true);
    expect(Array.isArray(res.body.urls_detail)).toBe(true);
  });

  it('marks flow as unclassified when application is Unknown', async () => {
    const flow = fakeFlow({ id: 1, application: 'Unknown' });
    mockQueryOne.mockResolvedValueOnce(flow);
    mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const res = await request(app)
      .get('/api/flows/1')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body._unclassified).toBe(true);
  });
});
