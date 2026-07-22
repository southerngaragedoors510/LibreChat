import TransportStream from 'winston-transport';
import mongoose from 'mongoose';
import type { Model } from 'mongoose';
import type { IErrorLog } from '~/types';

const MAX_MESSAGE = 4000;
const MAX_STACK = 8000;
const MAX_CONTEXT_VALUE = 1000;
const MAX_CONTEXT_KEYS = 20;

/** Fields already captured as top-level columns, or winston-internal noise. */
const RESERVED_KEYS = new Set(['message', 'stack', 'level', 'timestamp', 'splat']);

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

export interface MongoErrorTransportOptions extends TransportStream.TransportStreamOptions {
  /** Returns the registered ErrorLog model, or undefined if not yet registered. Injectable for tests. */
  getModel?: () => Model<IErrorLog> | undefined;
  /** Whether the MongoDB connection is ready for writes. Injectable for tests. */
  isConnected?: () => boolean;
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

  constructor(opts: MongoErrorTransportOptions = {}) {
    super(opts);
    this.getModel =
      opts.getModel ?? (() => mongoose.models.ErrorLog as Model<IErrorLog> | undefined);
    this.isConnected = opts.isConnected ?? (() => mongoose.connection?.readyState === 1);
  }

  log(info: Record<string, unknown>, callback: () => void): void {
    setImmediate(() => this.emit('logged', info));
    this.persist(info);
    callback();
  }

  private persist(info: Record<string, unknown>): void {
    try {
      if (!this.isConnected()) {
        return;
      }
      const model = this.getModel();
      if (!model) {
        return;
      }
      void model.create(this.buildDoc(info)).catch(() => undefined);
    } catch {
      /* Logging must never throw. */
    }
  }

  buildDoc(info: Record<string, unknown>): Partial<IErrorLog> {
    const message = typeof info.message === 'string' ? info.message : String(info.message ?? '');
    const level = typeof info.level === 'string' ? info.level : 'error';
    const stack = typeof info.stack === 'string' ? info.stack : undefined;

    const context: Record<string, unknown> = {};
    let count = 0;
    for (const key of Object.keys(info)) {
      if (RESERVED_KEYS.has(key) || count >= MAX_CONTEXT_KEYS) {
        continue;
      }
      const value = info[key];
      const type = typeof value;
      if (value === null || type === 'number' || type === 'boolean') {
        context[key] = value;
        count += 1;
      } else if (type === 'string') {
        context[key] = truncate(value as string, MAX_CONTEXT_VALUE);
        count += 1;
      }
    }

    return {
      timestamp: new Date(),
      level,
      message: truncate(message, MAX_MESSAGE),
      ...(stack ? { stack: truncate(stack, MAX_STACK) } : {}),
      ...(Object.keys(context).length ? { context } : {}),
    };
  }
}

export default MongoErrorTransport;
