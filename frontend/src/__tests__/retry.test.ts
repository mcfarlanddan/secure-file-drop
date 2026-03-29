/**
 * Tests for retry utilities
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  withRetry,
  calculateBackoffDelay,
  isRetryableHttpError,
  sleep,
} from '../retry';

describe('calculateBackoffDelay', () => {
  it('should calculate exponential backoff', () => {
    const baseDelay = 1000;
    const maxDelay = 10000;
    const jitter = 0; // No jitter for predictable test

    expect(calculateBackoffDelay(0, baseDelay, maxDelay, jitter)).toBe(1000);
    expect(calculateBackoffDelay(1, baseDelay, maxDelay, jitter)).toBe(2000);
    expect(calculateBackoffDelay(2, baseDelay, maxDelay, jitter)).toBe(4000);
  });

  it('should cap at maximum delay', () => {
    const baseDelay = 1000;
    const maxDelay = 5000;
    const jitter = 0;

    expect(calculateBackoffDelay(10, baseDelay, maxDelay, jitter)).toBe(5000);
  });

  it('should apply jitter for randomization', () => {
    const baseDelay = 1000;
    const maxDelay = 10000;
    const jitter = 0.3;

    const delays = Array.from({ length: 100 }, () =>
      calculateBackoffDelay(0, baseDelay, maxDelay, jitter)
    );

    const min = Math.min(...delays);
    const max = Math.max(...delays);

    expect(min).toBeLessThan(1000);
    expect(max).toBeGreaterThan(1000);
    expect(min).toBeGreaterThanOrEqual(700);
    expect(max).toBeLessThanOrEqual(1300);
  });

  it('should never return negative delay', () => {
    const delays = Array.from({ length: 100 }, () =>
      calculateBackoffDelay(0, 100, 1000, 2.0)
    );

    delays.forEach((delay) => {
      expect(delay).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('isRetryableHttpError', () => {
  it('should return true for 5xx errors', () => {
    expect(isRetryableHttpError(500)).toBe(true);
    expect(isRetryableHttpError(502)).toBe(true);
    expect(isRetryableHttpError(503)).toBe(true);
    expect(isRetryableHttpError(504)).toBe(true);
  });

  it('should return false for 4xx errors', () => {
    expect(isRetryableHttpError(400)).toBe(false);
    expect(isRetryableHttpError(401)).toBe(false);
    expect(isRetryableHttpError(403)).toBe(false);
    expect(isRetryableHttpError(404)).toBe(false);
  });

  it('should return false for 2xx success', () => {
    expect(isRetryableHttpError(200)).toBe(false);
    expect(isRetryableHttpError(201)).toBe(false);
  });

  it('should return true for network errors (no status)', () => {
    expect(isRetryableHttpError(undefined)).toBe(true);
  });
});

describe('sleep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should resolve after specified delay', async () => {
    const promise = sleep(1000);

    vi.advanceTimersByTime(999);
    await vi.runAllTimersAsync();

    vi.advanceTimersByTime(1);
    await expect(promise).resolves.toBeUndefined();
  });

  it('should reject immediately if signal already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(sleep(1000, controller.signal)).rejects.toThrow('Operation aborted');
  });

  it('should reject if signal aborted during delay', async () => {
    const controller = new AbortController();
    const promise = sleep(1000, controller.signal);

    vi.advanceTimersByTime(500);
    controller.abort();

    await expect(promise).rejects.toThrow('Operation aborted');
  });
});

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should succeed on first attempt without retry', async () => {
    const mockFn = vi.fn().mockResolvedValue('success');
    const retryFn = withRetry(mockFn, { baseDelayMs: 1000 });

    const result = await retryFn('arg1', 'arg2');

    expect(result).toBe('success');
    expect(mockFn).toHaveBeenCalledTimes(1);
    expect(mockFn).toHaveBeenCalledWith('arg1', 'arg2');
  });

  it('should retry on retryable error (5xx)', async () => {
    const error = new Error('Server error') as Error & { status: number };
    error.status = 503;

    const mockFn = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValue('success');

    const onRetry = vi.fn();
    const retryFn = withRetry(mockFn, { baseDelayMs: 1000, onRetry });

    const promise = retryFn();

    await vi.advanceTimersByTimeAsync(0);
    expect(mockFn).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1500);
    expect(mockFn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(3000);
    expect(mockFn).toHaveBeenCalledTimes(3);

    const result = await promise;
    expect(result).toBe('success');
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('should not retry on 4xx client error', async () => {
    const error = new Error('Client error') as Error & { status: number };
    error.status = 404;

    const mockFn = vi.fn().mockRejectedValue(error);
    const onRetry = vi.fn();
    const retryFn = withRetry(mockFn, { baseDelayMs: 1000, onRetry });

    await expect(retryFn()).rejects.toThrow('Client error');
    expect(mockFn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('should respect maxAttempts limit', async () => {
    const error = new Error('Network error');
    const mockFn = vi.fn().mockRejectedValue(error);
    const onRetry = vi.fn();

    const retryFn = withRetry(mockFn, {
      maxAttempts: 3,
      baseDelayMs: 100,
      jitterFactor: 0, // No jitter for predictable timing
      onRetry,
    });

    // Attach rejection handler immediately to prevent unhandled rejection
    let caughtError: Error | null = null;
    const promise = retryFn().catch((e) => { caughtError = e; });

    // Run all timers to completion
    await vi.runAllTimersAsync();
    await promise;

    // Assert the expected behavior
    expect(caughtError).toBeInstanceOf(Error);
    expect(caughtError!.message).toBe('Network error');
    expect(mockFn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('should abort if signal triggered before attempt', async () => {
    const controller = new AbortController();
    const mockFn = vi.fn().mockResolvedValue('success');
    const retryFn = withRetry(mockFn, { signal: controller.signal });

    controller.abort();

    await expect(retryFn()).rejects.toThrow('Operation aborted');
    expect(mockFn).not.toHaveBeenCalled();
  });

  it('should abort if signal triggered during retry delay', async () => {
    const error = new Error('Network error');
    const controller = new AbortController();
    const mockFn = vi.fn().mockRejectedValue(error);
    const onRetry = vi.fn();

    const retryFn = withRetry(mockFn, {
      signal: controller.signal,
      baseDelayMs: 1000,
      onRetry,
    });

    const promise = retryFn();

    await vi.advanceTimersByTimeAsync(0);
    expect(mockFn).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    controller.abort();

    await expect(promise).rejects.toThrow('Operation aborted');
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('should invoke onRetry callback with correct parameters', async () => {
    const error = new Error('Network error');
    const mockFn = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue('success');

    const onRetry = vi.fn();
    const retryFn = withRetry(mockFn, {
      baseDelayMs: 1000,
      jitterFactor: 0,
      onRetry,
    });

    const promise = retryFn();

    await vi.advanceTimersByTimeAsync(0);
    expect(onRetry).toHaveBeenCalledWith(0, 1000, error);

    await vi.advanceTimersByTimeAsync(1000);
    await promise;
  });

  it('should handle non-Error throws', async () => {
    const mockFn = vi.fn().mockRejectedValue('string error');
    const retryFn = withRetry(mockFn, { maxAttempts: 1 });

    await expect(retryFn()).rejects.toThrow('string error');
  });
});

describe('integration: uploadPart with retry', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function uploadPartRaw(
    url: string,
    chunk: Blob,
    partNumber: number,
    signal: AbortSignal
  ): Promise<string> {
    const response = await fetch(url, {
      method: 'PUT',
      body: chunk,
      signal,
    });

    if (!response.ok) {
      const error = new Error(`Failed to upload part ${partNumber}`) as Error & { status: number };
      error.status = response.status;
      throw error;
    }

    const etag = response.headers.get('ETag');
    if (!etag) {
      throw new Error(`No ETag received for part ${partNumber}`);
    }

    return etag;
  }

  it('should retry part upload on 503 and succeed', async () => {
    const controller = new AbortController();
    const chunk = new Blob(['test data']);
    const mockHeaders = new Headers();
    mockHeaders.set('ETag', '"abc123"');

    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200, headers: mockHeaders });

    const onRetry = vi.fn();
    const uploadPart = withRetry(uploadPartRaw, {
      baseDelayMs: 1000,
      signal: controller.signal,
      onRetry,
    });

    const promise = uploadPart('https://s3.aws.com/presigned', chunk, 1, controller.signal);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(3000);

    const etag = await promise;

    expect(etag).toBe('"abc123"');
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });
});
