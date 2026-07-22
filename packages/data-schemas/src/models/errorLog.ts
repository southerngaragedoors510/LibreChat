import type { Model } from 'mongoose';
import type { IErrorLog } from '~/types';
import errorLogSchema from '~/schema/errorLog';

export function createErrorLogModel(mongoose: typeof import('mongoose')): Model<IErrorLog> {
  return mongoose.models.ErrorLog || mongoose.model<IErrorLog>('ErrorLog', errorLogSchema);
}
