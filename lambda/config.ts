/**
 * Lambda configuration with Zod validation
 *
 * Validates environment variables at startup to fail fast
 * rather than encountering undefined values at runtime.
 */

import { z } from 'zod';
import { DEFAULT_MAX_PART_NUMBERS_PER_REQUEST, MAX_S3_PART_NUMBER } from '../shared';

/**
 * Schema for Lambda environment variables.
 * All required values must be present or the Lambda will fail immediately.
 */
const ConfigSchema = z.object({
  /** S3 bucket name for uploads and metadata */
  bucketName: z
    .string()
    .min(3, 'BUCKET_NAME must be at least 3 characters')
    .max(63, 'BUCKET_NAME must be at most 63 characters'),

  /** SNS topic ARN for notifications */
  snsTopicArn: z
    .string()
    .regex(
      /^arn:aws:sns:[a-z0-9-]+:\d{12}:[a-zA-Z0-9_-]+$/,
      'SNS_TOPIC_ARN must be a valid SNS ARN'
    ),

  /** Maximum part numbers per presign request */
  maxPartNumbers: z
    .number()
    .int()
    .positive()
    .max(MAX_S3_PART_NUMBER, `MAX_PART_NUMBERS cannot exceed S3 limit of ${MAX_S3_PART_NUMBER.toLocaleString()}`),
});

export type HandlerConfig = z.infer<typeof ConfigSchema>;

/**
 * Configuration validation error with details.
 */
export class ConfigValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: z.ZodIssue[]
  ) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Validates and returns Lambda configuration from environment variables.
 *
 * @throws ConfigValidationError if required env vars are missing or invalid
 * @returns Validated configuration object
 *
 * @example
 * // In handler initialization
 * const config = getValidatedConfig();
 * // If BUCKET_NAME is missing, throws immediately with clear error
 */
export function getValidatedConfig(): HandlerConfig {
  const rawConfig = {
    bucketName: process.env.BUCKET_NAME,
    snsTopicArn: process.env.SNS_TOPIC_ARN,
    maxPartNumbers: parseIntOrUndefined(process.env.MAX_PART_NUMBERS),
  };

  const result = ConfigSchema.safeParse({
    ...rawConfig,
    // Apply defaults for optional numeric fields
    maxPartNumbers: rawConfig.maxPartNumbers ?? DEFAULT_MAX_PART_NUMBERS_PER_REQUEST,
  });

  if (!result.success) {
    const issues = result.error.issues;
    const message = formatValidationErrors(issues);
    throw new ConfigValidationError(
      `Lambda configuration validation failed:\n${message}`,
      issues
    );
  }

  return result.data;
}

/**
 * Parses a string to integer, returning undefined if invalid.
 */
function parseIntOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? undefined : parsed;
}

/**
 * Formats Zod validation errors into readable messages.
 */
function formatValidationErrors(issues: z.ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.join('.');
      return `  - ${path || 'config'}: ${issue.message}`;
    })
    .join('\n');
}

/**
 * Singleton config instance.
 * Validated once at module load time for fail-fast behavior.
 */
let cachedConfig: HandlerConfig | null = null;

/**
 * Gets the validated configuration, caching the result.
 * Use this in production code for efficiency.
 */
export function getConfig(): HandlerConfig {
  if (cachedConfig === null) {
    cachedConfig = getValidatedConfig();
  }
  return cachedConfig;
}

/**
 * Clears the cached configuration.
 * Only used in tests to reset state between test cases.
 */
export function clearConfigCache(): void {
  cachedConfig = null;
}
