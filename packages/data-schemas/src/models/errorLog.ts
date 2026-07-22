import type { Model } from 'mongoose';
import type { IErrorLog } from '~/types';
import errorLogSchema, { ERROR_LOG_COLLECTION, ERROR_LOG_CAPPED } from '~/schema/errorLog';
import logger from '~/config/winston';

export function createErrorLogModel(mongoose: typeof import('mongoose')): Model<IErrorLog> {
  return mongoose.models.ErrorLog || mongoose.model<IErrorLog>('ErrorLog', errorLogSchema);
}

/**
 * Guarantees the error-log collection exists as a **capped** collection before
 * any error can be written.
 *
 * Relying on Mongoose `autoCreate` alone is unsafe here: it's disabled by the
 * documented `MONGO_AUTO_CREATE=false` option, and even when enabled its
 * `createCollection` resolves asynchronously after connect — an error logged in
 * that window would auto-create the collection *uncapped* via the insert, and
 * it would stay uncapped forever (unbounded growth). Call this right after the
 * DB connects, before the app starts serving.
 *
 * Idempotent: a no-op when the capped collection already exists; warns (does not
 * silently accept) if a pre-existing collection is uncapped.
 */
export async function ensureErrorLogCollection(mongoose: typeof import('mongoose')): Promise<void> {
  const connection = mongoose.connection;
  if (connection?.readyState !== 1 || !connection.db) {
    return;
  }
  const db = connection.db;
  const existing = await db.listCollections({ name: ERROR_LOG_COLLECTION }).toArray();
  if (existing.length === 0) {
    try {
      await db.createCollection(ERROR_LOG_COLLECTION, {
        capped: true,
        size: ERROR_LOG_CAPPED.size,
        max: ERROR_LOG_CAPPED.max,
      });
    } catch (error) {
      // NamespaceExists (48): a concurrent create (autoCreate or another
      // instance) won the race — the collection now exists, which is the goal.
      if ((error as { code?: number })?.code !== 48) {
        throw error;
      }
    }
    return;
  }
  if (existing[0].options?.capped !== true) {
    logger.warn(
      `[errorLog] Collection "${ERROR_LOG_COLLECTION}" exists but is NOT capped — storage is unbounded. ` +
        `Convert it once with: db.runCommand({ convertToCapped: "${ERROR_LOG_COLLECTION}", size: ${ERROR_LOG_CAPPED.size} })`,
    );
  }
}
