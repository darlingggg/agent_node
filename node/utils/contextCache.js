const estimateValueBytes = (value) => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return 0;
  return Buffer.byteLength(serialized, 'utf8') * 2;
};

export class ContextCache {
  constructor({
    ttlMs,
    maxEntries,
    maxTotalBytes,
    maxEntryBytes,
    cleanupIntervalMs,
    sizeOf = estimateValueBytes,
    now = Date.now,
  }) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.maxTotalBytes = maxTotalBytes;
    this.maxEntryBytes = maxEntryBytes;
    this.sizeOf = sizeOf;
    this.now = now;
    this.entries = new Map();
    this.totalBytes = 0;

    this.cleanupTimer = cleanupIntervalMs > 0
      ? setInterval(() => this.deleteExpired(), cleanupIntervalMs)
      : null;
    this.cleanupTimer?.unref?.();
  }

  get size() {
    return this.entries.size;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    const now = this.now();
    if (entry.expiresAt <= now) {
      this.delete(key);
      return undefined;
    }

    entry.expiresAt = now + this.ttlMs;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    // Never retain stale context when its replacement is too large to cache.
    this.delete(key);
    let estimatedBytes;
    try {
      estimatedBytes = this.sizeOf(value);
    } catch {
      return false;
    }
    if (!Number.isFinite(estimatedBytes) || estimatedBytes < 0 || estimatedBytes > this.maxEntryBytes) {
      return false;
    }

    this.deleteExpired();
    this.entries.set(key, {
      value,
      estimatedBytes,
      expiresAt: this.now() + this.ttlMs,
    });
    this.totalBytes += estimatedBytes;
    this.evictToLimits();
    return this.entries.has(key);
  }

  delete(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;

    this.totalBytes -= entry.estimatedBytes;
    this.entries.delete(key);
    return true;
  }

  deleteExpired() {
    const now = this.now();
    let deleted = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now && this.delete(key)) deleted += 1;
    }
    return deleted;
  }

  evictToLimits() {
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxTotalBytes) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.delete(oldestKey);
    }
  }

  close() {
    if (!this.cleanupTimer) return;
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }
}
