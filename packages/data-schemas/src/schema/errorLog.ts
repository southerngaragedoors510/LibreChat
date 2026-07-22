import { Schema } from 'mongoose';
import type { IErrorLog } from '~/types';

/**
 * Append-only error log stored in a **capped** collection: MongoDB evicts the
 * oldest documents once either bound is reached, so storage is self-limiting
 * and needs no cleanup job. Sized for recent-error debugging, not long-term
 * retention (that's what Render's own logs / an external sink are for).
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
    capped: { size: 10 * 1024 * 1024, max: 5000 },
    versionKey: false,
  },
);

export default errorLogSchema;
