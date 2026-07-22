import mongoose from 'mongoose';
import winston from 'winston';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createErrorLogModel } from '~/models/errorLog';
import { MongoErrorTransport } from './errorTransport';
import type { IErrorLog } from '~/types';

let mongoServer: MongoMemoryServer;
let ErrorLog: mongoose.Model<IErrorLog>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  ErrorLog = createErrorLogModel(mongoose);
  // Force capped-collection creation before any write.
  await ErrorLog.createCollection();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await ErrorLog.deleteMany({}).catch(() => undefined);
});

/** Flush the transport's fire-and-forget `model.create(...)` promise. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('MongoErrorTransport (integration)', () => {
  it('creates the ErrorLog collection as capped', async () => {
    const collections = await mongoose.connection
      .db!.listCollections({ name: 'errorlogs' })
      .toArray();
    expect(collections).toHaveLength(1);
    expect(collections[0].options?.capped).toBe(true);
  });

  it('persists an error logged through a real winston logger, readable back', async () => {
    const logger = winston.createLogger({
      level: 'error',
      transports: [new MongoErrorTransport({ level: 'error' })],
    });

    logger.error('integration boom', { userId: 'user-xyz', attempt: 2 });
    await flush();

    const docs = await ErrorLog.find({}).lean();
    expect(docs).toHaveLength(1);
    expect(docs[0].message).toBe('integration boom');
    expect(docs[0].level).toBe('error');
    expect(docs[0].context).toMatchObject({ userId: 'user-xyz', attempt: 2 });
    expect(docs[0].timestamp).toBeInstanceOf(Date);
  });

  it('does not capture non-error levels', async () => {
    const logger = winston.createLogger({
      level: 'silly',
      transports: [new MongoErrorTransport({ level: 'error' })],
    });

    logger.warn('a warning');
    logger.info('some info');
    await flush();

    const count = await ErrorLog.countDocuments({});
    expect(count).toBe(0);
  });
});
