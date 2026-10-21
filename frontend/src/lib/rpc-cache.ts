// RPC call memoization cache for reducing redundant contract queries (#119)
import { cacheScope } from "./network-config";

interface CacheEntry<T> {
  value: T;
  timestamp: number;
}

/**
 * Simple in-memory cache for RPC call results with TTL.
 * Keyed by a composite string that includes circle_id, cycle, and member address.
 */
class RPCCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  private readonly defaultTTL: number;

  constructor(defaultTTLMs = 30000) {
    // 30s default TTL
    this.defaultTTL = defaultTTLMs;
  }

  /**
   * Generate a cache key for hasContributed calls, scoped to the current
   * network + contract (#303).
   * Format: "{scope}:contrib:{circleId}:{cycle}:{member}"
   */
  contributionKey(circleId: bigint, cycle: number, member: string, scope: string = cacheScope()): string {
    return `${scope}:contrib:${circleId}:${cycle}:${member}`;
  }

  /**
   * Generate a cache key for missedCount calls, scoped to the current
   * network + contract (#303).
   * Format: "{scope}:missed:{circleId}:{member}"
   */
  missedKey(circleId: bigint, member: string, scope: string = cacheScope()): string {
    return `${scope}:missed:${circleId}:${member}`;
  }

  /**
   * Get cached value if exists and not expired.
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;

    const now = Date.now();
    if (now - entry.timestamp > this.defaultTTL) {
      this.cache.delete(key);
      return null;
    }

    return entry.value;
  }

  /**
   * Store value in cache with current timestamp.
   */
  set<T>(key: string, value: T): void {
    this.cache.set(key, {
      value,
      timestamp: Date.now(),
    });
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Clear entries matching a pattern (e.g., all entries for a specific circle).
   */
  clearPattern(pattern: string): void {
    const toDelete: string[] = [];
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        toDelete.push(key);
      }
    }
    toDelete.forEach((k) => this.cache.delete(k));
  }

  /**
   * Get cache statistics for debugging.
   */
  getStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }
}

// Singleton instance
export const rpcCache = new RPCCache(30000); // 30 second TTL

/**
 * Cache confirmed contributions only: they cannot revert within a cycle.
 * Recheck unpaid members on every refresh so other members' payments are visible.
 */
export async function hasContributedCached(
  hasContributedFn: (circleId: bigint, cycle: number, member: string) => Promise<boolean>,
  circleId: bigint,
  cycle: number,
  member: string,
): Promise<boolean> {
  const key = rpcCache.contributionKey(circleId, cycle, member);
  const cached = rpcCache.get<boolean>(key);
  if (cached !== null) {
    return cached;
  }

  const result = await hasContributedFn(circleId, cycle, member);
  if (result) {
    rpcCache.set(key, result);
  }
  return result;
}

/**
 * Wrapper for missedCount with caching.
 * Use this instead of calling missedCount directly for automatic memoization.
 */
export async function missedCountCached(
  missedCountFn: (circleId: bigint, member: string) => Promise<number>,
  circleId: bigint,
  member: string,
): Promise<number> {
  const key = rpcCache.missedKey(circleId, member);
  const cached = rpcCache.get<number>(key);
  if (cached !== null) {
    return cached;
  }

  const result = await missedCountFn(circleId, member);
  rpcCache.set(key, result);
  return result;
}

/**
 * Invalidate cache for a specific circle.
 * Call this after mutations (join/contribute/disburse/leave/cancel) to ensure fresh data.
 */
export function invalidateCircleCache(circleId: bigint): void {
  rpcCache.clearPattern(`:${circleId}:`);
}
