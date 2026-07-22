/// <reference types="jest" />
import express from 'express';
import request from 'supertest';
import { createErrorLogRouter, isErrorLogConfigured } from './index';
import type { ErrorLogEntry } from './index';

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

const SECRET = 'test-secret-value';

function buildApp(getRecentErrors: jest.Mock) {
  const app = express();
  app.use('/api/error-log', createErrorLogRouter({ getRecentErrors }));
  return app;
}

const sampleEntry: ErrorLogEntry = {
  timestamp: new Date('2026-07-22T00:00:00.000Z'),
  level: 'error',
  message: 'boom',
};

describe('createErrorLogRouter', () => {
  const originalSecret = process.env.ERROR_LOG_SECRET;

  beforeEach(() => {
    process.env.ERROR_LOG_SECRET = SECRET;
  });

  afterAll(() => {
    if (originalSecret === undefined) {
      delete process.env.ERROR_LOG_SECRET;
    } else {
      process.env.ERROR_LOG_SECRET = originalSecret;
    }
  });

  it('returns 401 when no Authorization header is sent', async () => {
    const getRecentErrors = jest.fn();
    const res = await request(buildApp(getRecentErrors)).get('/api/error-log');
    expect(res.status).toBe(401);
    expect(getRecentErrors).not.toHaveBeenCalled();
  });

  it('returns 401 for a wrong token', async () => {
    const getRecentErrors = jest.fn();
    const res = await request(buildApp(getRecentErrors))
      .get('/api/error-log')
      .set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(401);
    expect(getRecentErrors).not.toHaveBeenCalled();
  });

  it('returns 401 when the secret is not configured, even with a bearer token', async () => {
    delete process.env.ERROR_LOG_SECRET;
    const getRecentErrors = jest.fn();
    const res = await request(buildApp(getRecentErrors))
      .get('/api/error-log')
      .set('Authorization', `Bearer ${SECRET}`);
    expect(res.status).toBe(401);
    expect(getRecentErrors).not.toHaveBeenCalled();
  });

  it('returns 200 with the errors for a correct token', async () => {
    const getRecentErrors = jest.fn().mockResolvedValue([sampleEntry]);
    const res = await request(buildApp(getRecentErrors))
      .get('/api/error-log')
      .set('Authorization', `Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.errors[0].message).toBe('boom');
    expect(getRecentErrors).toHaveBeenCalledWith({ limit: 100, since: undefined });
  });

  it('clamps limit to the 1..500 range and parses a valid since date', async () => {
    const getRecentErrors = jest.fn().mockResolvedValue([]);
    await request(buildApp(getRecentErrors))
      .get('/api/error-log?limit=9999&since=2026-07-01T00:00:00.000Z')
      .set('Authorization', `Bearer ${SECRET}`);
    expect(getRecentErrors).toHaveBeenCalledWith({
      limit: 500,
      since: new Date('2026-07-01T00:00:00.000Z'),
    });
  });

  it('falls back to the default limit for a non-numeric limit and ignores an invalid since', async () => {
    const getRecentErrors = jest.fn().mockResolvedValue([]);
    await request(buildApp(getRecentErrors))
      .get('/api/error-log?limit=abc&since=not-a-date')
      .set('Authorization', `Bearer ${SECRET}`);
    expect(getRecentErrors).toHaveBeenCalledWith({ limit: 100, since: undefined });
  });

  it('returns 500 when the reader rejects', async () => {
    const getRecentErrors = jest.fn().mockRejectedValue(new Error('db down'));
    const res = await request(buildApp(getRecentErrors))
      .get('/api/error-log')
      .set('Authorization', `Bearer ${SECRET}`);
    expect(res.status).toBe(500);
  });
});

describe('isErrorLogConfigured', () => {
  const originalSecret = process.env.ERROR_LOG_SECRET;
  afterAll(() => {
    if (originalSecret === undefined) {
      delete process.env.ERROR_LOG_SECRET;
    } else {
      process.env.ERROR_LOG_SECRET = originalSecret;
    }
  });

  it('is true when the secret is set and false otherwise', () => {
    process.env.ERROR_LOG_SECRET = SECRET;
    expect(isErrorLogConfigured()).toBe(true);
    delete process.env.ERROR_LOG_SECRET;
    expect(isErrorLogConfigured()).toBe(false);
  });
});
