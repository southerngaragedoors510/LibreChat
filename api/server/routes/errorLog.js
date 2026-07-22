const mongoose = require('mongoose');
const { createErrorLogRouter } = require('@librechat/api');

/**
 * Reads the most recent captured errors from the capped `ErrorLog` collection,
 * newest first. Returns [] when the model isn't registered (feature disabled or
 * pre-connection), so the endpoint degrades quietly rather than erroring.
 */
async function getRecentErrors({ limit, since }) {
  const model = mongoose.models.ErrorLog;
  if (!model) {
    return [];
  }
  const query = since ? { timestamp: { $gte: since } } : {};
  const docs = await model.find(query).sort({ timestamp: -1 }).limit(limit).lean();
  return docs.map((doc) => ({
    timestamp: doc.timestamp,
    level: doc.level,
    message: doc.message,
    stack: doc.stack,
    context: doc.context,
  }));
}

module.exports = createErrorLogRouter({ getRecentErrors });
