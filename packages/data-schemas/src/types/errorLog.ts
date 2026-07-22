import type { Document } from 'mongoose';

/**
 * A persisted backend error entry, captured from the winston `error` level and
 * stored in a capped MongoDB collection for later inspection via the
 * token-protected `/api/error-log` endpoint.
 */
export interface IErrorLog extends Document {
  /** When the error was captured (server time). */
  timestamp: Date;
  /** Log level — always `'error'` for entries this transport captures. */
  level: string;
  /** The (redacted, truncated) log message. */
  message: string;
  /** The (truncated) error stack, when present. */
  stack?: string;
  /** Bounded, redacted scalar context fields carried on the log entry. */
  context?: Record<string, unknown>;
}
