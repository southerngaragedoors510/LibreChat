import { Router } from 'express';
import { timingSafeEqual } from 'crypto';
import { logger } from '@librechat/data-schemas';
import type { Request, RequestHandler } from 'express';

/** One stored error, as returned to the client. */
export interface ErrorLogEntry {
  timestamp: Date | string;
  level: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
}

export interface CreateErrorLogRouterOptions {
  /** Reads the most recent errors, newest first. Injected by the app layer. */
  getRecentErrors: (opts: { limit: number; since?: Date }) => Promise<ErrorLogEntry[]>;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** Whether the error-log feature is enabled (both capture and read are gated on this). */
export function isErrorLogConfigured(): boolean {
  return Boolean(process.env.ERROR_LOG_SECRET);
}

/**
 * Timing-safe bearer-token check against `ERROR_LOG_SECRET`, mirroring the
 * `/metrics` endpoint's auth. Returns false (deny) when the secret is unset, so
 * the endpoint is closed unless the feature is explicitly enabled.
 */
function isAuthorized(req: Request): boolean {
  const secret = process.env.ERROR_LOG_SECRET;
  const auth = req.headers['authorization'];
  if (!secret || !auth) {
    return false;
  }
  const bearerToken = auth.match(/^bearer\s+(.+)$/i);
  if (!bearerToken) {
    return false;
  }
  const encode = (value: string) => new TextEncoder().encode(value);
  const expected = encode(secret);
  const actual = encode(bearerToken[1]);
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
}

/**
 * Builds the `GET /` router that returns recent backend errors as JSON, guarded
 * by the `ERROR_LOG_SECRET` bearer token. Query params: `limit` (1..500,
 * default 100) and `since` (ISO date).
 */
export function createErrorLogRouter({ getRecentErrors }: CreateErrorLogRouterOptions): Router {
  const router = Router();

  const handler: RequestHandler = (req, res): void => {
    if (!isAuthorized(req)) {
      res.status(401).end();
      return;
    }

    const parsedLimit = parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), MAX_LIMIT)
      : DEFAULT_LIMIT;

    let since: Date | undefined;
    if (typeof req.query.since === 'string' && req.query.since) {
      const parsed = new Date(req.query.since);
      if (!Number.isNaN(parsed.getTime())) {
        since = parsed;
      }
    }

    void getRecentErrors({ limit, since })
      .then((errors) => {
        res.json({ count: errors.length, errors });
      })
      .catch((err) => {
        logger.error('[errorLog] Failed to read error log:', err);
        res.status(500).end();
      });
  };

  router.get('/', handler);
  return router;
}
