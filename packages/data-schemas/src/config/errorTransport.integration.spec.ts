// Keep the real winston logger quiet during the integration run.
process.env.LOG_TO_FILE = 'false';

import mongoose from 'mongoose';
import winston from 'winston';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createErrorLogModel, ensureErrorLogCollection } from '~/models/errorLog';
import { ERROR_LOG_COLLECTION } from '~/schema/errorLog';
import { createMongoErrorTransport } from './winston';
import appLogger from './winston';
import { tenantStorage } from './tenantContext';
import type { IErrorLog } from '~/types';

let mongoServer: MongoMemoryServer;
let ErrorLog: mongoose.Model<IErrorLog>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  ErrorLog = createErrorLogModel(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

async function dropCollection() {
  const existing = await mongoose.connection
    .db!.listCollections({ name: ERROR_LOG_COLLECTION })
    .toArray();
  if (existing.length > 0) {
    await mongoose.connection.db!.dropCollection(ERROR_LOG_COLLECTION);
  }
}

async function collectionOptions() {
  const list = await mongoose.connection
    .db!.listCollections({ name: ERROR_LOG_COLLECTION })
    .toArray();
  return list[0]?.options ?? null;
}

/** Flush the transport's fire-and-forget `model.create(...)` promise. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 60));

describe('ensureErrorLogCollection', () => {
  beforeEach(async () => {
    await dropCollection();
  });

  it('creates the collection as capped when it does not exist', async () => {
    await ensureErrorLogCollection(mongoose);
    const options = await collectionOptions();
    expect(options?.capped).toBe(true);
    expect(options?.max).toBe(5000);
  });

  it('is idempotent when the capped collection already exists', async () => {
    await ensureErrorLogCollection(mongoose);
    await expect(ensureErrorLogCollection(mongoose)).resolves.toBeUndefined();
    const options = await collectionOptions();
    expect(options?.capped).toBe(true);
  });

  it('warns (and does not throw) when a pre-existing collection is not capped', async () => {
    await mongoose.connection.db!.createCollection(ERROR_LOG_COLLECTION); // uncapped
    const warnSpy = jest.spyOn(appLogger, 'warn').mockImplementation(() => appLogger);
    try {
      await expect(ensureErrorLogCollection(mongoose)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain('NOT capped');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('MongoErrorTransport (integration, real logger wiring)', () => {
  let logger: winston.Logger;

  beforeAll(() => {
    logger = winston.createLogger({
      level: 'error',
      transports: [createMongoErrorTransport()],
    });
  });

  beforeEach(async () => {
    await dropCollection();
    await ensureErrorLogCollection(mongoose);
  });

  it('persists an error logged through the transport, readable back', async () => {
    logger.error('integration boom', { userId: 'user-xyz', attempt: 2 });
    await flush();

    const docs = await ErrorLog.find({}).lean();
    expect(docs).toHaveLength(1);
    expect(docs[0].message).toBe('integration boom');
    expect(docs[0].level).toBe('error');
    expect(docs[0].context).toMatchObject({ userId: 'user-xyz', attempt: 2 });
    expect(docs[0].timestamp).toBeInstanceOf(Date);
  });

  it('captures the stack when an Error is logged as the message', async () => {
    logger.error(new Error('kaboom-detail'));
    await flush();

    const docs = await ErrorLog.find({}).lean();
    expect(docs).toHaveLength(1);
    expect(docs[0].message).toContain('kaboom-detail');
    expect(docs[0].stack).toContain('kaboom-detail');
  });

  it('captures the stack for the prefix + Error meta shape (the common call site)', async () => {
    logger.error('[Provider] request failed', new Error('upstream-detail'));
    await flush();

    const docs = await ErrorLog.find({}).lean();
    expect(docs).toHaveLength(1);
    expect(docs[0].message).toContain('[Provider] request failed');
    expect(docs[0].stack).toContain('upstream-detail');
  });

  it('redacts secrets in the message and sensitive context keys, keeping safe scalars', async () => {
    logger.error('auth failed: Bearer topsecret-token-abc', {
      password: 'hunter2',
      userId: 'user-1',
    });
    await flush();

    const docs = await ErrorLog.find({}).lean();
    expect(docs).toHaveLength(1);
    expect(docs[0].message).not.toContain('topsecret-token-abc');
    expect(docs[0].message).toContain('[REDACTED]');
    expect(docs[0].context?.password).toBe('[REDACTED]');
    expect(docs[0].context?.userId).toBe('user-1');
  });

  it('enriches context with ambient request identifiers from AsyncLocalStorage', async () => {
    await tenantStorage.run(
      { userId: 'ambient-user', tenantId: 'tenant-7', requestId: 'req-abc' },
      async () => {
        logger.error('failure inside a request');
      },
    );
    await flush();

    const docs = await ErrorLog.find({}).lean();
    expect(docs).toHaveLength(1);
    expect(docs[0].context).toMatchObject({
      userId: 'ambient-user',
      tenantId: 'tenant-7',
      requestId: 'req-abc',
    });
  });

  it('does not capture non-error levels', async () => {
    const infoLogger = winston.createLogger({
      level: 'silly',
      transports: [createMongoErrorTransport()],
    });
    infoLogger.warn('a warning');
    infoLogger.info('some info');
    await flush();

    expect(await ErrorLog.countDocuments({})).toBe(0);
  });
});
