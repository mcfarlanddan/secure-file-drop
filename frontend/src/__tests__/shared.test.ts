/**
 * Tests for shared utilities
 */

import { describe, it, expect } from 'vitest';
import {
  formatBytes,
  MAX_FILENAME_LENGTH,
  MAX_FILE_SIZE,
  DEFAULT_CHUNK_SIZE,
  MAX_S3_PART_NUMBER,
  isRetryableError,
  isAbortError,
} from '@shared/index';

describe('formatBytes', () => {
  it('should format 0 bytes', () => {
    expect(formatBytes(0)).toBe('0 Bytes');
  });

  it('should format bytes', () => {
    expect(formatBytes(500)).toBe('500 Bytes');
  });

  it('should format kilobytes', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('should format megabytes', () => {
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });

  it('should format gigabytes', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
  });

  it('should format terabytes', () => {
    expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe('1 TB');
  });

  it('should handle large numbers', () => {
    expect(formatBytes(5 * 1024 * 1024 * 1024 * 1024)).toBe('5 TB');
  });
});

describe('constants', () => {
  it('should have correct MAX_FILENAME_LENGTH', () => {
    expect(MAX_FILENAME_LENGTH).toBe(255);
  });

  it('should have correct MAX_FILE_SIZE (5TB)', () => {
    expect(MAX_FILE_SIZE).toBe(5 * 1024 * 1024 * 1024 * 1024);
  });

  it('should have correct DEFAULT_CHUNK_SIZE (64MB)', () => {
    expect(DEFAULT_CHUNK_SIZE).toBe(64 * 1024 * 1024);
  });

  it('should have correct MAX_S3_PART_NUMBER', () => {
    expect(MAX_S3_PART_NUMBER).toBe(10_000);
  });
});

describe('isAbortError', () => {
  it('should detect AbortError by name', () => {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    expect(isAbortError(error)).toBe(true);
  });

  it('should detect abort by message', () => {
    expect(isAbortError(new Error('Request was aborted'))).toBe(true);
    expect(isAbortError(new Error('User cancelled the operation'))).toBe(true);
  });

  it('should not detect regular errors as abort', () => {
    expect(isAbortError(new Error('Network error'))).toBe(false);
    expect(isAbortError(new Error('Server error'))).toBe(false);
  });

  it('should handle null and undefined', () => {
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});

describe('isRetryableError', () => {
  it('should retry on HTTP 5xx errors', () => {
    const error = new Error('Server error') as Error & { status: number };
    error.status = 500;
    expect(isRetryableError(error)).toBe(true);

    error.status = 502;
    expect(isRetryableError(error)).toBe(true);

    error.status = 503;
    expect(isRetryableError(error)).toBe(true);
  });

  it('should retry on HTTP 429 (rate limiting)', () => {
    const error = new Error('Too many requests') as Error & { status: number };
    error.status = 429;
    expect(isRetryableError(error)).toBe(true);
  });

  it('should NOT retry on HTTP 4xx errors (except 429)', () => {
    const error = new Error('Client error') as Error & { status: number };
    error.status = 400;
    expect(isRetryableError(error)).toBe(false);

    error.status = 401;
    expect(isRetryableError(error)).toBe(false);

    error.status = 403;
    expect(isRetryableError(error)).toBe(false);

    error.status = 404;
    expect(isRetryableError(error)).toBe(false);
  });

  it('should retry on TypeError (network errors)', () => {
    expect(isRetryableError(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('should retry on timeout errors', () => {
    expect(isRetryableError(new Error('Request timeout'))).toBe(true);
  });

  it('should retry on network errors', () => {
    expect(isRetryableError(new Error('Network error'))).toBe(true);
    expect(isRetryableError(new Error('Connection refused'))).toBe(true);
  });

  it('should NOT retry on abort errors', () => {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    expect(isRetryableError(error)).toBe(false);
  });
});
