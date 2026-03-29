/**
 * Retry utilities with exponential backoff for network operations.
 *
 * This module provides a generic retry wrapper that:
 * - Implements exponential backoff with jitter
 * - Respects AbortSignal for cancellation
 * - Classifies errors as retryable or permanent
 * - Provides hooks for progress announcements
 */

import {
  RETRY_MAX_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  RETRY_JITTER_FACTOR,
  isAbortError,
  isRetryableError,
} from '@shared/index';

// ============================================================================
// TYPES
// ============================================================================

export interface RetryOptions {
  /** Maximum retry attempts (default: 3) */
  maxAttempts?: number;
  /** Base delay in milliseconds (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay cap in milliseconds (default: 10000) */
  maxDelayMs?: number;
  /** Jitter factor 0-1 for randomization (default: 0.3) */
  jitterFactor?: number;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Callback invoked before each retry */
  onRetry?: (attempt: number, delayMs: number, error: Error) => void;
}

export type RetryableFunction<A extends unknown[], T> = (...args: A) => Promise<T>;

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Calculate exponential backoff delay with jitter.
 * Formula: min(maxDelay, baseDelay * 2^attempt) ± (jitter * delay)
 *
 * @param attempt - Zero-indexed attempt number
 * @param baseDelayMs - Base delay in milliseconds
 * @param maxDelayMs - Maximum delay cap
 * @param jitterFactor - Jitter factor (0-1)
 * @returns Delay in milliseconds
 */
export function calculateBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitterFactor: number
): number {
  // Exponential: 2^attempt
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);

  // Cap at maximum
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

  // Add jitter: ±(jitterFactor * delay)
  const jitter = cappedDelay * jitterFactor * (Math.random() * 2 - 1);

  return Math.max(0, Math.round(cappedDelay + jitter));
}

/**
 * Check if HTTP status code is retryable (5xx or network error).
 *
 * @param status - HTTP status code (or undefined for network errors)
 * @returns true if this status should trigger a retry
 */
export function isRetryableHttpError(status?: number): boolean {
  if (status === undefined) return true; // Network errors (no status)
  return status >= 500 && status < 600; // 5xx server errors
}

/**
 * Sleep with optional AbortSignal for cancellation.
 * Throws if signal is aborted during delay.
 *
 * @param ms - Milliseconds to sleep
 * @param signal - Optional AbortSignal
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Operation aborted'));
      return;
    }

    const timeout = setTimeout(resolve, ms);

    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error('Operation aborted'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Extract HTTP status from various error types.
 */
function extractHttpStatus(error: unknown): number | undefined {
  if (error instanceof Response) return error.status;
  if (error && typeof error === 'object' && 'status' in error) {
    return (error as { status: number }).status;
  }
  return undefined;
}

/**
 * Check if error should be retried.
 */
function shouldRetry(error: unknown): boolean {
  // Don't retry abort errors
  if (isAbortError(error)) return false;

  // Use shared retry logic
  if (isRetryableError(error)) return true;

  // Check HTTP status
  const status = extractHttpStatus(error);
  return isRetryableHttpError(status);
}

// ============================================================================
// RETRY WRAPPER
// ============================================================================

/**
 * Wraps an async function with retry logic.
 *
 * @example
 * const uploadWithRetry = withRetry(uploadPart, {
 *   signal: abortController.signal,
 *   onRetry: (attempt, delay) => console.log(`Retry ${attempt} in ${delay}ms`)
 * });
 *
 * @param fn - Async function to wrap
 * @param options - Retry options
 * @returns Wrapped function with retry logic
 */
export function withRetry<A extends unknown[], T>(
  fn: RetryableFunction<A, T>,
  options: RetryOptions = {}
): RetryableFunction<A, T> {
  const {
    maxAttempts = RETRY_MAX_ATTEMPTS,
    baseDelayMs = RETRY_BASE_DELAY_MS,
    maxDelayMs = RETRY_MAX_DELAY_MS,
    jitterFactor = RETRY_JITTER_FACTOR,
    signal,
    onRetry,
  } = options;

  return async function retryWrapper(...args: A): Promise<T> {
    let lastError: Error = new Error('No attempts made');

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        // Check abort before each attempt
        if (signal?.aborted) {
          throw new Error('Operation aborted');
        }

        return await fn(...args);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry on last attempt
        const isLastAttempt = attempt === maxAttempts - 1;
        if (isLastAttempt) {
          throw lastError;
        }

        // Don't retry non-retryable errors
        if (!shouldRetry(error)) {
          throw lastError;
        }

        // Calculate backoff delay
        const delayMs = calculateBackoffDelay(
          attempt,
          baseDelayMs,
          maxDelayMs,
          jitterFactor
        );

        // Notify before retry
        if (onRetry) {
          onRetry(attempt, delayMs, lastError);
        }

        // Wait with abort support
        try {
          await sleep(delayMs, signal);
        } catch (sleepError) {
          // If aborted during sleep, throw abort error instead
          // sleepError is expected to be an abort - log if it's something else
          if (sleepError instanceof Error && !sleepError.message.includes('abort')) {
            console.warn('Unexpected error during retry sleep:', sleepError.message);
          }
          throw new Error('Operation aborted');
        }
      }
    }

    // Should never reach here, but TypeScript requires it
    throw lastError;
  };
}
