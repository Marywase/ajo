// Contract tests.
import { TransactionBuilder } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendWithRetry, server, submitSignedTx } from "./contract";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("submitSignedTx polling", () => {
  function mockSubmission() {
    vi.spyOn(TransactionBuilder, "fromXDR").mockReturnValue({} as never);
    vi.spyOn(server, "sendTransaction").mockResolvedValue({
      status: "PENDING",
      hash: "abc",
    } as never);
  }

  it("continues polling after a transient getTransaction error", async () => {
    vi.useFakeTimers();
    mockSubmission();
    const getTransaction = vi
      .spyOn(server, "getTransaction")
      .mockRejectedValueOnce(new Error("RPC temporarily unavailable"))
      .mockResolvedValueOnce({ status: "SUCCESS", returnValue: undefined } as never);

    const submission = submitSignedTx("signed-xdr");
    await vi.advanceTimersByTimeAsync(1500);

    await expect(submission).resolves.toBeUndefined();
    expect(getTransaction).toHaveBeenCalledTimes(2);
  });

  it("throws the final polling error after exhausting the attempt budget", async () => {
    vi.useFakeTimers();
    mockSubmission();
    const pollingError = new Error("RPC connection reset");
    const getTransaction = vi.spyOn(server, "getTransaction").mockRejectedValue(pollingError);

    const submission = submitSignedTx("signed-xdr");
    const rejection = expect(submission).rejects.toBe(pollingError);
    await vi.advanceTimersByTimeAsync(39 * 1500);

    await rejection;
    expect(getTransaction).toHaveBeenCalledTimes(40);
  });
});

describe("sendWithRetry (#150)", () => {
  function mockServer(sendTransaction: (...args: unknown[]) => unknown) {
    return { sendTransaction } as unknown as Parameters<typeof sendWithRetry>[0];
  }

  it("returns immediately on PENDING without retrying", async () => {
    const sendTransaction = vi.fn().mockResolvedValue({ status: "PENDING", hash: "abc" });
    const result = await sendWithRetry(mockServer(sendTransaction), {} as never);
    expect(result.status).toBe("PENDING");
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("returns DUPLICATE as-is without retrying, so the caller proceeds to polling", async () => {
    const sendTransaction = vi.fn().mockResolvedValue({ status: "DUPLICATE", hash: "abc" });
    const result = await sendWithRetry(mockServer(sendTransaction), {} as never);
    expect(result.status).toBe("DUPLICATE");
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("returns ERROR as-is without retrying", async () => {
    const sendTransaction = vi.fn().mockResolvedValue({ status: "ERROR", hash: "abc" });
    const result = await sendWithRetry(mockServer(sendTransaction), {} as never);
    expect(result.status).toBe("ERROR");
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("retries with backoff on TRY_AGAIN_LATER, then returns the eventual success", async () => {
    vi.useFakeTimers();
    try {
      const sendTransaction = vi
        .fn()
        .mockResolvedValueOnce({ status: "TRY_AGAIN_LATER", hash: "abc" })
        .mockResolvedValueOnce({ status: "TRY_AGAIN_LATER", hash: "abc" })
        .mockResolvedValueOnce({ status: "PENDING", hash: "abc" });

      const promise = sendWithRetry(mockServer(sendTransaction), {} as never);
      // Two backoff delays (500ms, 1000ms) must elapse between the three calls.
      await vi.advanceTimersByTimeAsync(2000);

      const result = await promise;
      expect(result.status).toBe("PENDING");
      expect(sendTransaction).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after the max retry attempts, returning the last TRY_AGAIN_LATER response", async () => {
    vi.useFakeTimers();
    try {
      const sendTransaction = vi.fn().mockResolvedValue({ status: "TRY_AGAIN_LATER", hash: "abc" });
      const promise = sendWithRetry(mockServer(sendTransaction), {} as never);
      await vi.advanceTimersByTimeAsync(60_000);

      const result = await promise;
      expect(result.status).toBe("TRY_AGAIN_LATER");
      // 1 initial attempt + 5 retries = 6 total calls.
      expect(sendTransaction).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });
});
