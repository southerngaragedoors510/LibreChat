import { Schema } from 'mongoose';
import type { IErrorLog } from '~/types';

/** Mongoose-pluralized collection name for the ErrorLog model. */
export const ERROR_LOG_COLLECTION = 'errorlogs';

/** Capped-collection bounds: whichever of size/count is hit first evicts oldest. */
export const ERROR_LOG_CAPPED = { size: 10 * 1024 * 1024, max: 5000 } as const;

/**
 * Append-only error log stored in a **capped** collection: MongoDB evicts the
 * oldest documents once either bound is reached, so storage is self-limiting
 * and needs no cleanup job. Sized for recent-error debugging, not long-term
 * retention (that's what the host's own logs / an external sink are for).
 */
const errorLogSchema: Schema<IErrorLog> = new Schema<IErrorLog>(
  {
    timestamp: { type: Date, required: true, default: Date.now, index: true },
    level: { type: String, required: true },
    message: { type: String, required: true },
    stack: { type: String },
    context: { type: Schema.Types.Mixed },
  },
  {
    capped: { size: ERROR_LOG_CAPPED.size, max: ERROR_LOG_CAPPED.max },
    versionKey: false,
  },
);

export default errorLogSchema;
