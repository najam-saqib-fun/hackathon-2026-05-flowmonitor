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

const { signToken, verifyToken } = require('../auth');

describe('auth helpers', () => {
  describe('signToken', () => {
    it('returns a non-empty JWT string', () => {
      const token = signToken({ id: 1, username: 'alice', role: 'admin' });
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3); // header.payload.signature
    });

    it('embeds the supplied payload fields', () => {
      const payload = { id: 42, username: 'bob', role: 'viewer' };
      const token = signToken(payload);
      const decoded = verifyToken(token);
      expect(decoded.id).toBe(42);
      expect(decoded.username).toBe('bob');
      expect(decoded.role).toBe('viewer');
    });

    it('produces different tokens for different payloads', () => {
      const t1 = signToken({ id: 1, username: 'alice', role: 'admin' });
      const t2 = signToken({ id: 2, username: 'bob', role: 'viewer' });
      expect(t1).not.toBe(t2);
    });
  });

  describe('verifyToken', () => {
    it('verifies a token signed with the same secret and returns payload', () => {
      const token = signToken({ id: 7, username: 'carol', role: 'admin' });
      const decoded = verifyToken(token);
      expect(decoded.id).toBe(7);
      expect(decoded.username).toBe('carol');
      expect(decoded.role).toBe('admin');
    });

    it('throws when given a completely invalid token', () => {
      expect(() => verifyToken('not.a.token')).toThrow();
    });

    it('throws when given a token signed with a different secret', () => {
      const jwt = require('jsonwebtoken');
      const badToken = jwt.sign({ id: 1 }, 'wrong-secret');
      expect(() => verifyToken(badToken)).toThrow();
    });

    it('throws when given an empty string', () => {
      expect(() => verifyToken('')).toThrow();
    });
  });
});
