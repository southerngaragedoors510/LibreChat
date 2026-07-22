import TransportStream from 'winston-transport';
import mongoose from 'mongoose';
import type { Model } from 'mongoose';
import type { IErrorLog } from '~/types';
import { redactMessage, isSensitiveMetadataKey } from './parsers';

const MAX_MESSAGE = 4000;
const MAX_STACK = 8000;
const MAX_CONTEXT_VALUE = 1000;
const MAX_CONTEXT_KEYS = 20;
/**
 * Cap on concurrent in-flight inserts. An error storm (e.g. a provider outage
 * spraying thousands of `logger.error` calls) must not saturate the shared
 * Mongoose connection pool and starve the rest of the app; excess entries are
 * dropped rather than queued.
 */
const DEFAULT_MAX_INFLIGHT = 50;

/** Fields already captured as top-level columns, or winston-internal noise. */
const RESERVED_KEYS = new Set(['message', 'stack', 'level', 'timestamp', 'splat']);

/** Placeholder written in place of a sensitive-keyed context value. */
const REDACTED = '[REDACTED]';

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

interface ErrorLike {
  message?: string;
  stack?: string;
}

/**
 * Recognizes an Error, or the plain `{ message, stack, name, code }` shape that
 * winston's redaction produces from an Error. Used to pull message/stack out of
 * whichever position the error was logged in (as the message, or as a meta arg
 * in `splat` — whose stack is non-enumerable and so never merged onto `info`).
 */
function asErrorLike(value: unknown): ErrorLike | undefined {
  if (value instanceof Error) {
    return { message: value.message, stack: value.stack };
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const stack = typeof record.stack === 'string' ? record.stack : undefined;
    const message = typeof record.message === 'string' ? record.message : undefined;
    if (stack || message) {
      return { message, stack };
    }
  }
  return undefined;
}

const SPLAT = Symbol.for('splat');
const RENDERED_MESSAGE = Symbol.for('message');

export interface MongoErrorTransportOptions extends TransportStream.TransportStreamOptions {
  /** Returns the registered ErrorLog model, or undefined if not yet registered. Injectable for tests. */
  getModel?: () => Model<IErrorLog> | undefined;
  /** Whether the MongoDB connection is ready for writes. Injectable for tests. */
  isConnected?: () => boolean;
  /** Max concurrent inserts before entries are dropped. Defaults to 50. */
  maxInFlight?: number;
}

/**
 * Winston transport that persists error-level log entries to the capped
 * `ErrorLog` MongoDB collection so they can be read back for debugging.
 *
 * Defensive by design — logging must never become a failure source:
 * - never throws out of `log()`;
 * - drops the entry (returns quietly) when the DB is unavailable or the model
 *   isn't registered yet;
 * - swallows write errors, and never calls the app logger on failure (that
 *   would recurse, since this transport is attached to that same logger).
 */
export class MongoErrorTransport extends TransportStream {
  private readonly getModel: () => Model<IErrorLog> | undefined;
  private readonly isConnected: () => boolean;
  private readonly maxInFlight: number;
  private inFlight = 0;

  constructor(opts: MongoErrorTransportOptions = {}) {
    super(opts);
    this.getModel =
      opts.getModel ?? (() => mongoose.models.ErrorLog as Model<IErrorLog> | undefined);
    this.isConnected = opts.isConnected ?? (() => mongoose.connection?.readyState === 1);
    this.maxInFlight = opts.maxInFlight ?? DEFAULT_MAX_INFLIGHT;
  }

  log(info: Record<string, unknown>, callback: () => void): void {
    setImmediate(() => this.emit('logged', info));
    this.persist(info);
    callback();
  }

  private persist(info: Record<string, unknown>): void {
    try {
      if (!this.isConnected() || this.inFlight >= this.maxInFlight) {
        return;
      }
      const model = this.getModel();
      if (!model) {
        return;
      }
      // Capture the promise BEFORE incrementing, so a synchronous throw from
      // create() (caught below) can't leak an increment and permanently wedge
      // the in-flight counter at the cap.
      const pending = model.create(this.buildDoc(info));
      this.inFlight += 1;
      void pending
        .catch(() => undefined)
        .finally(() => {
          this.inFlight -= 1;
        });
    } catch {
      /* Logging must never throw. */
    }
  }

  /**
   * Builds the stored document, redacting defensively. The transport is wired
   * with `fileFormat` (which redacts `message`/splat), but redaction is applied
   * again here for the paths that format chain does NOT cover: the extracted
   * `stack` (populated by winston's `errors` format AFTER `redactFormat` runs)
   * and top-level metadata keys (merged onto `info`, never seen by
   * `redactFormat`). Redaction is idempotent, so double-redacting is safe.
   */
  buildDoc(info: Record<string, unknown>): Partial<IErrorLog> {
    const level = typeof info.level === 'string' ? info.level : 'error';

    // The error may be in the message position or a meta arg; find it in either.
    const splat = (info as Record<symbol, unknown>)[SPLAT];
    const errorLike =
      asErrorLike(info.message) ??
      (Array.isArray(splat) ? splat.map(asErrorLike).find(Boolean) : undefined);

    // Resolve a NON-EMPTY message: the string message, else the error's message,
    // else winston's rendered message, else a placeholder. An empty message
    // would fail the schema's `required` check and the write would be dropped.
    let rawMessage = typeof info.message === 'string' ? info.message : '';
    if (!rawMessage && errorLike?.message) {
      rawMessage = errorLike.message;
    }
    if (!rawMessage) {
      const rendered = (info as Record<symbol, unknown>)[RENDERED_MESSAGE];
      rawMessage = typeof rendered === 'string' ? rendered : '';
    }
    if (!rawMessage) {
      rawMessage = '(no message)';
    }

    let rawStack: string | undefined;
    if (typeof info.stack === 'string') {
      rawStack = info.stack;
    } else if (typeof errorLike?.stack === 'string') {
      rawStack = errorLike.stack;
    }

    const message = truncate(redactMessage(rawMessage), MAX_MESSAGE);
    const stack = rawStack ? truncate(redactMessage(rawStack), MAX_STACK) : undefined;

    const context: Record<string, unknown> = {};
    let count = 0;
    for (const key of Object.keys(info)) {
      if (count >= MAX_CONTEXT_KEYS) {
        break;
      }
      if (RESERVED_KEYS.has(key)) {
        continue;
      }
      if (isSensitiveMetadataKey(key)) {
        context[key] = REDACTED;
        count += 1;
        continue;
      }
      const value = info[key];
      const type = typeof value;
      if (value === null || type === 'number' || type === 'boolean') {
        context[key] = value;
        count += 1;
      } else if (type === 'string') {
        context[key] = truncate(redactMessage(value as string), MAX_CONTEXT_VALUE);
        count += 1;
      }
    }

    return {
      timestamp: new Date(),
      level,
      message,
      ...(stack ? { stack } : {}),
      ...(Object.keys(context).length ? { context } : {}),
    };
  }
}

export default MongoErrorTransport;
