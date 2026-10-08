import { ContextCache } from '../../utils/contextCache.js';

export const contextCache = new ContextCache({
  ttlMs: 3 * 60 * 60 * 1000,
  maxEntries: 100,
  maxTotalBytes: 64 * 1024 * 1024,
  maxEntryBytes: 16 * 1024 * 1024,
  cleanupIntervalMs: 10 * 60 * 1000,
});
