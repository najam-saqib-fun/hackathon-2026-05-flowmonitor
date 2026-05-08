'use strict';

// Mock logger to silence Winston output in tests
jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// Mock db to avoid real MySQL connections
jest.mock('../db', () => ({
  getPool: jest.fn().mockResolvedValue({}),
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const { requireAuth, requireAdmin } = require('../middleware/auth');
const { signToken } = require('../auth');

function makeReqRes(authHeader) {
  const req = { headers: {} };
  if (authHeader !== undefined) {
    req.headers['authorization'] = authHeader;
  }
  const res = {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body)   { this._body = body; return this; },
  };
  return { req, res };
}

describe('requireAuth middleware', () => {
  it('returns 401 when Authorization header is missing', () => {
    const { req, res } = makeReqRes();
    const next = jest.fn();
    requireAuth(req, res, next);
    expect(res._status).toBe(401);
    expect(res._body).toMatchObject({ error: expect.any(String) });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when Authorization header is present but has no Bearer prefix', () => {
    const { req, res } = makeReqRes('Basic somebase64value');
    const next = jest.fn();
    requireAuth(req, res, next);
    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token is invalid (random string)', () => {
    const { req, res } = makeReqRes('Bearer this.is.garbage');
    const next = jest.fn();
    requireAuth(req, res, next);
    expect(res._status).toBe(401);
    expect(res._body).toMatchObject({ error: expect.any(String) });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token is signed with a different secret', () => {
    const jwt = require('jsonwebtoken');
    const badToken = jwt.sign({ id: 1, role: 'admin' }, 'wrong-secret');
    const { req, res } = makeReqRes(`Bearer ${badToken}`);
    const next = jest.fn();
    requireAuth(req, res, next);
    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() and attaches user to req when token is valid', () => {
    const token = signToken({ id: 5, username: 'dave', role: 'viewer' });
    const { req, res } = makeReqRes(`Bearer ${token}`);
    const next = jest.fn();
    requireAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeDefined();
    expect(req.user.id).toBe(5);
    expect(req.user.username).toBe('dave');
    expect(req.user.role).toBe('viewer');
  });

  it('the attached req.user contains the original payload fields', () => {
    const token = signToken({ id: 99, username: 'superuser', role: 'admin' });
    const { req, res } = makeReqRes(`Bearer ${token}`);
    const next = jest.fn();
    requireAuth(req, res, next);
    expect(req.user.id).toBe(99);
    expect(req.user.username).toBe('superuser');
    expect(req.user.role).toBe('admin');
  });
});

describe('requireAdmin middleware', () => {
  it('returns 401 when no token is provided', () => {
    const { req, res } = makeReqRes();
    const next = jest.fn();
    requireAdmin(req, res, next);
    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when token belongs to a viewer role', () => {
    const token = signToken({ id: 2, username: 'viewer1', role: 'viewer' });
    const { req, res } = makeReqRes(`Bearer ${token}`);
    const next = jest.fn();
    requireAdmin(req, res, next);
    expect(res._status).toBe(403);
    expect(res._body).toMatchObject({ error: expect.any(String) });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when token belongs to an admin role', () => {
    const token = signToken({ id: 1, username: 'admin', role: 'admin' });
    const { req, res } = makeReqRes(`Bearer ${token}`);
    const next = jest.fn();
    requireAdmin(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
