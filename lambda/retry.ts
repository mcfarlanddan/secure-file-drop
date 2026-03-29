/**
 * Retry utilities for AWS SDK operations in Lambda.
 *
 * While AWS SDK v3 has built-in retry logic, it doesn't automatically retry
 * on service throttling (503) or temporary availability issues. This module
 * provides additional retry capability for critical operations.
 */

import type { Logger } from './handler';

/**
 * Configuration for retry behavior.
 */
export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;
  /** Base delay in milliseconds (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay in milliseconds (default: 10000) */
  maxDelayMs?: number;
  /** Jitter factor 0-1 to randomize delays (default: 0.3) */
  jitterFactor?: number;
}

const DEFAULT_CONFIG: Required<RetryConfig> = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  jitterFactor: 0.3,
};

/**
 * Error codes that indicate transient failures worth retrying.
 */
const RETRYABLE_ERROR_CODES = new Set([
  'ServiceUnavailable',
  'InternalError',
  'RequestTimeout',
  'ThrottlingException',
  'Throttling',
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
  'BandwidthLimitExceeded',
  'RequestThrottled',
  'SlowDown',
  'TooManyRequestsException',
  '503',
  '500',
  '502',
  '504',
]);

/**
 * HTTP status codes that indicate transient failures.
 */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

interface AwsError {
  name?: string;
  $metadata?: {
    httpStatusCode?: number;
  };
  code?: string;
}

/**
 * Determines if an error is retryable based on error code or HTTP status.
 */
function isRetryableError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const awsError = error as AwsError;

  // Check error name/code
  if (awsError.name && RETRYABLE_ERROR_CODES.has(awsError.name)) {
    return true;
  }
  if (awsError.code && RETRYABLE_ERROR_CODES.has(awsError.code)) {
    return true;
  }

  // Check HTTP status code
  const statusCode = awsError.$metadata?.httpStatusCode;
  if (statusCode && RETRYABLE_STATUS_CODES.has(statusCode)) {
    return true;
  }

  return false;
}

/**
 * Calculates delay with exponential backoff and jitter.
 */
function calculateDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitterFactor: number
): number {
  // Exponential backoff: base * 2^attempt
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

  // Add jitter: delay +/- (jitterFactor * delay)
  const jitter = cappedDelay * jitterFactor * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(cappedDelay + jitter));
}

/**
 * Sleeps for the specified duration.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Executes an async operation with retry logic.
 *
 * Retries on transient AWS errors (throttling, service unavailable, etc.)
 * with exponential backoff and jitter.
 *
 * @param operation - The async operation to execute
 * @param operationName - Name for logging purposes
 * @param logger - Logger instance for retry messages
 * @param config - Retry configuration
 * @returns The result of the operation
 * @throws The last error if all retries are exhausted
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  logger: Logger,
  config: RetryConfig = {}
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs, jitterFactor } = {
    ...DEFAULT_CONFIG,
    ...config,
  };

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // Don't retry non-retryable errors
      if (!isRetryableError(error)) {
        throw error;
      }

      // Don't retry if this was the last attempt
      if (attempt === maxAttempts - 1) {
        logger.error(`${operationName} failed after ${maxAttempts} attempts`, {
          error: String(error),
          attempts: maxAttempts,
        });
        throw error;
      }

      // Calculate and apply delay
      const delay = calculateDelay(attempt, baseDelayMs, maxDelayMs, jitterFactor);
      logger.warn(`${operationName} failed, retrying in ${delay}ms`, {
        attempt: attempt + 1,
        maxAttempts,
        error: String(error),
        delay,
      });

      await sleep(delay);
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError;
}
