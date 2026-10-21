import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasContributedCached, invalidateCircleCache, rpcCache } from "./rpc-cache";

describe("hasContributedCached (#351)", () => {
  beforeEach(() => {
    rpcCache.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    rpcCache.clear();
    vi.useRealTimers();
  });

  it("sees another member's payment on the next refresh before the TTL expires", async () => {
    const query = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);

    await expect(hasContributedCached(query, 1n, 0, "GM")).resolves.toBe(false);
    vi.advanceTimersByTime(1_000);
    await expect(hasContributedCached(query, 1n, 0, "GM")).resolves.toBe(true);
    await expect(hasContributedCached(query, 1n, 0, "GM")).resolves.toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenLastCalledWith(1n, 0, "GM");
  });

  it("queries again on every refresh while the member remains unpaid", async () => {
    const query = vi.fn().mockResolvedValue(false);

    await expect(hasContributedCached(query, 1n, 0, "GM")).resolves.toBe(false);
    await expect(hasContributedCached(query, 1n, 0, "GM")).resolves.toBe(false);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a confirmed contribution for another cycle, member, or circle", async () => {
    const query = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);

    await expect(hasContributedCached(query, 1n, 0, "GM")).resolves.toBe(true);
    await expect(hasContributedCached(query, 1n, 1, "GM")).resolves.toBe(false);
    await expect(hasContributedCached(query, 1n, 0, "GN")).resolves.toBe(false);
    await expect(hasContributedCached(query, 2n, 0, "GM")).resolves.toBe(false);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("retains expiry and explicit invalidation for confirmed contributions", async () => {
    const query = vi.fn().mockResolvedValue(true);

    await hasContributedCached(query, 1n, 0, "GM");
    await hasContributedCached(query, 1n, 0, "GM");
    expect(query).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_001);
    await hasContributedCached(query, 1n, 0, "GM");
    expect(query).toHaveBeenCalledTimes(2);
    invalidateCircleCache(1n);
    await hasContributedCached(query, 1n, 0, "GM");
    expect(query).toHaveBeenCalledTimes(3);
  });
});
