/**
 * Shared utilities and types for Secure File Drop
 *
 * This module provides common functionality used by both the Lambda backend
 * and the frontend. All exports here are pure functions with no external
 * dependencies (no AWS SDK, no DOM APIs, no Node.js built-ins).
 */

// ============================================================================
// ERROR CODES
// ============================================================================

/**
 * Structured error codes for API responses.
 * Enables frontend to handle specific error cases programmatically.
 */
export enum ErrorCode {
  // Validation errors (4xx)
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INVALID_EMAIL = 'INVALID_EMAIL',
  INVALID_FILENAME = 'INVALID_FILENAME',
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',
  DANGEROUS_CONTENT_TYPE = 'DANGEROUS_CONTENT_TYPE',
  INVALID_PART_NUMBERS = 'INVALID_PART_NUMBERS',
  TOO_MANY_PARTS = 'TOO_MANY_PARTS',
  INVALID_UUID = 'INVALID_UUID',
  MISSING_REQUIRED_FIELD = 'MISSING_REQUIRED_FIELD',

  // Upload state errors (4xx)
  UPLOAD_NOT_FOUND = 'UPLOAD_NOT_FOUND',
  UPLOAD_ALREADY_COMPLETED = 'UPLOAD_ALREADY_COMPLETED',
  UPLOAD_EXPIRED = 'UPLOAD_EXPIRED',

  // Server errors (5xx)
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  S3_ERROR = 'S3_ERROR',
  SNS_ERROR = 'SNS_ERROR',

  // Not found
  NOT_FOUND = 'NOT_FOUND',
}

/**
 * Standard API error response structure.
 */
export interface ApiError {
  /** Machine-readable error code */
  code: ErrorCode;
  /** Human-readable error message */
  error: string;
  /** Additional details (e.g., field-specific validation errors) */
  details?: string;
  /** Request ID for support/debugging */
  requestId?: string;
}

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Formats a byte count into a human-readable string.
 *
 * @param bytes - The number of bytes to format
 * @returns A formatted string like "1.5 MB" or "0 Bytes"
 *
 * @example
 * formatBytes(1536) // "1.5 KB"
 * formatBytes(0)    // "0 Bytes"
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ============================================================================
// TYPES
// ============================================================================

/**
 * Metadata stored alongside each upload in S3.
 * Created during /initiate, read during /complete, deleted after completion.
 */
export interface UploadMetadata {
  /** Submitter's email address */
  email: string;
  /** User-provided title (defaults to fileName if not provided) */
  title: string;
  /** User-provided description */
  description: string;
  /** Original filename (sanitized) */
  fileName: string;
  /** File size in bytes */
  fileSize: number;
  /** MIME type */
  contentType: string;
  /** Unique identifier for this submission */
  submissionId: string;
  /** S3 multipart upload ID */
  uploadId: string;
  /** S3 object key */
  key: string;
  /** ISO 8601 timestamp when upload was initiated */
  createdAt: string;
  /**
   * Deterministic hash for idempotency checking (email|fileName|fileSize).
   * Optional for backward compatibility with metadata created before idempotency
   * feature was added, and for fallback objects when metadata cannot be read.
   */
  idempotencyKey?: string;
}

/**
 * A completed part in a multipart upload.
 */
export interface UploadPart {
  PartNumber: number;
  ETag: string;
}

/**
 * Part information returned by the /status endpoint.
 */
export interface CompletedPartInfo {
  partNumber: number;
  etag: string;
  size: number;
}

// ============================================================================
// API REQUEST/RESPONSE TYPES
// ============================================================================

/**
 * Request body for POST /api/initiate.
 * Initiates a new multipart upload session.
 */
export interface InitiateRequest {
  /** Submitter's email address for notifications */
  email: string;
  /** Optional human-readable title for the upload */
  title?: string;
  /** Optional description or notes about the upload */
  description?: string;
  /** Original filename (will be sanitized server-side) */
  fileName: string;
  /** Total file size in bytes */
  fileSize: number;
  /** MIME content type (defaults to application/octet-stream) */
  contentType?: string;
}

/**
 * Response from POST /api/initiate.
 * Contains all information needed to upload file parts.
 */
export interface InitiateResponse {
  /** Unique identifier for this submission */
  submissionId: string;
  /** S3 multipart upload ID */
  uploadId: string;
  /** S3 object key where the file will be stored */
  key: string;
  /** Total number of parts to upload */
  totalParts: number;
  /** Size of each chunk in bytes (except possibly the last) */
  chunkSize: number;
  /** True if this is an idempotent response (existing upload found) */
  idempotent?: boolean;
}

/**
 * Request body for POST /api/presign.
 * Requests presigned URLs for uploading specific parts.
 */
export interface PresignRequest {
  /** S3 multipart upload ID from initiate response */
  uploadId: string;
  /** S3 object key from initiate response */
  key: string;
  /** Array of 1-indexed part numbers to get presigned URLs for */
  partNumbers: number[];
}

/**
 * Response from POST /api/presign.
 * Contains presigned URLs mapped to part numbers.
 */
export interface PresignResponse {
  /** Array of presigned URLs with their corresponding part numbers */
  urls: Array<{ partNumber: number; url: string }>;
}

/**
 * Request body for POST /api/complete.
 * Finalizes the multipart upload after all parts are uploaded.
 */
export interface CompleteRequest {
  /** S3 multipart upload ID from initiate response */
  uploadId: string;
  /** S3 object key from initiate response */
  key: string;
  /** Array of uploaded parts with their ETags (returned by S3 on PUT) */
  parts: UploadPart[];
  /** Submission ID from initiate response */
  submissionId: string;
}

/**
 * Response from POST /api/complete.
 * Confirms successful upload completion.
 */
export interface CompleteResponse {
  /** Whether the completion was successful */
  success: boolean;
  /** Human-readable status message */
  message: string;
  /** Whether the email notification was successfully sent */
  notificationSent: boolean;
}

/**
 * Request body for POST /api/abort.
 * Cancels an in-progress multipart upload.
 */
export interface AbortRequest {
  /** S3 multipart upload ID from initiate response */
  uploadId: string;
  /** S3 object key from initiate response */
  key: string;
  /** Optional submission ID for metadata cleanup */
  submissionId?: string;
}

/**
 * Response from POST /api/abort.
 * Confirms successful upload cancellation.
 */
export interface AbortResponse {
  /** Whether the abort was successful */
  success: boolean;
  /** Human-readable status message */
  message: string;
}

/**
 * Request body for POST /api/status.
 * Checks the current status of a multipart upload.
 */
export interface StatusRequest {
  /** S3 multipart upload ID from initiate response */
  uploadId: string;
  /** S3 object key from initiate response */
  key: string;
}

/**
 * Response from POST /api/status.
 * Contains information about completed parts for resume functionality.
 */
export interface StatusResponse {
  /** Array of parts that have been successfully uploaded */
  completedParts: CompletedPartInfo[];
  /** Total number of completed parts */
  totalParts: number;
  /** Set to 'completed_or_aborted' if upload no longer exists */
  status?: 'completed_or_aborted';
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Maximum allowed filename length after sanitization */
export const MAX_FILENAME_LENGTH = 255;

/** Maximum file size (5TB - S3 multipart limit) */
export const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024 * 1024;

/** Default chunk size for multipart uploads (64MB) */
export const DEFAULT_CHUNK_SIZE = 64 * 1024 * 1024;

/** Maximum part number allowed by S3 multipart upload API */
export const MAX_S3_PART_NUMBER = 10_000;

/** Maximum S3 object key length per AWS documentation */
export const MAX_S3_KEY_LENGTH = 1024;

/** Maximum email address length per RFC 5321 */
export const MAX_EMAIL_LENGTH = 255;

/** Maximum title length for upload metadata */
export const MAX_TITLE_LENGTH = 500;

/** Maximum description length for upload metadata */
export const MAX_DESCRIPTION_LENGTH = 2000;

/** Maximum content type length */
export const MAX_CONTENT_TYPE_LENGTH = 100;

/** Default maximum part numbers per presign request (configurable via env) */
export const DEFAULT_MAX_PART_NUMBERS_PER_REQUEST = 100;

/** Maximum parts to retrieve per S3 ListParts request */
export const S3_LIST_PARTS_MAX_KEYS = 1000;

// ============================================================================
// CHUNK SIZE CALCULATION
// ============================================================================

/** Minimum chunk size for multipart uploads (5MB, S3 requirement except last part) */
export const MIN_CHUNK_SIZE = 5 * 1024 * 1024;

/** Maximum chunk size for practical memory/network limits (525MB to support full 5TB) */
export const MAX_CHUNK_SIZE = 525 * 1024 * 1024;

/** File size threshold where we switch from DEFAULT to calculated chunks (640GB) */
export const OPTIMAL_CHUNK_SIZE_THRESHOLD = 640 * 1024 * 1024 * 1024;

/**
 * Calculates optimal chunk size for multipart upload based on file size.
 *
 * Algorithm:
 * - Files ≤ 640GB: Use DEFAULT_CHUNK_SIZE (64MB) for optimal performance
 * - Larger files: Scale chunk size to stay under MAX_S3_PART_NUMBER (10,000 parts)
 * - Always respect MIN_CHUNK_SIZE (5MB) and cap at MAX_CHUNK_SIZE (525MB)
 *
 * @param fileSize - Total file size in bytes
 * @returns Optimal chunk size in bytes
 *
 * @example
 * calculateChunkSize(100 * 1024 * 1024 * 1024) // 64MB (100GB file)
 * calculateChunkSize(1024 * 1024 * 1024 * 1024) // ~109MB (1TB file)
 */
export function calculateChunkSize(fileSize: number): number {
  // Files under threshold use default chunk size
  if (fileSize <= OPTIMAL_CHUNK_SIZE_THRESHOLD) {
    return DEFAULT_CHUNK_SIZE;
  }

  // Calculate minimum chunk size to stay under S3's 10,000 part limit
  const minRequired = Math.ceil(fileSize / MAX_S3_PART_NUMBER);

  // Round up to next MB for cleaner values
  const roundedToMB = Math.ceil(minRequired / (1024 * 1024)) * (1024 * 1024);

  // Ensure within bounds
  return Math.max(MIN_CHUNK_SIZE, Math.min(roundedToMB, MAX_CHUNK_SIZE));
}

// ============================================================================
// RETRY CONFIGURATION
// ============================================================================

/** Maximum retry attempts for transient errors */
export const RETRY_MAX_ATTEMPTS = 3;

/** Base delay in milliseconds for exponential backoff */
export const RETRY_BASE_DELAY_MS = 1000;

/** Maximum delay cap in milliseconds */
export const RETRY_MAX_DELAY_MS = 10000;

/** Jitter factor for randomization (0-1, where 0.3 = ±30%) */
export const RETRY_JITTER_FACTOR = 0.3;

/**
 * Checks if an error represents an abort/cancellation.
 * Used to prevent retry on user-initiated cancellations.
 *
 * @param error - The error to check
 * @returns true if this is an abort error that should not be retried
 */
export function isAbortError(error: unknown): boolean {
  if (!error) return false;

  if (error instanceof Error) {
    const name = error.name.toLowerCase();
    const message = error.message.toLowerCase();
    return (
      name === 'aborterror' ||
      message.includes('aborted') ||
      message.includes('abort') ||
      message.includes('cancel')
    );
  }

  return false;
}

/**
 * Checks if an error is retryable (network or transient server errors).
 * Does NOT retry on abort errors or client errors (4xx).
 *
 * @param error - The error to check
 * @returns true if this error should trigger a retry
 */
export function isRetryableError(error: unknown): boolean {
  // Don't retry aborts
  if (isAbortError(error)) return false;

  // Network errors (TypeError from fetch)
  if (error instanceof TypeError) return true;

  // Check for HTTP status codes (5xx are retryable, 4xx are not)
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: number }).status;
    // Retry on 5xx server errors and 429 (rate limiting)
    if (status >= 500 || status === 429) {
      return true;
    }
    // Don't retry on 4xx client errors (except 429)
    if (status >= 400 && status < 500) {
      return false;
    }
  }

  // Check for common network error indicators
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (
      message.includes('timeout') ||
      message.includes('network') ||
      message.includes('failed to fetch') ||
      message.includes('connection')
    ) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// CONTENT-TYPE VALIDATION
// ============================================================================

/**
 * Dangerous MIME types that should never be stored as-is.
 * These types can execute code or render HTML/scripts in browsers.
 */
export const DANGEROUS_CONTENT_TYPES: ReadonlySet<string> = new Set([
  // HTML and variants
  'text/html',
  'application/xhtml+xml',
  // JavaScript
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  // Server-side scripts
  'application/x-php',
  'application/x-httpd-php',
  'text/x-php',
  // SVG (can contain scripts)
  'image/svg+xml',
  // XML with potential DTD entities
  'application/xml',
  'text/xml',
]);

/**
 * Dangerous prefixes that indicate executable content.
 */
export const DANGEROUS_CONTENT_TYPE_PREFIXES: ReadonlyArray<string> = [
  'application/x-sh',
  'application/x-csh',
  'text/x-script',
];

/** Safe fallback content type for untrusted files */
export const SAFE_FALLBACK_CONTENT_TYPE = 'application/octet-stream';

/**
 * Checks if a content type is dangerous.
 *
 * @param contentType - The MIME type to check
 * @returns true if this content type is dangerous
 */
export function isDangerousContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase().trim().split(';')[0];

  if (DANGEROUS_CONTENT_TYPES.has(normalized)) {
    return true;
  }

  return DANGEROUS_CONTENT_TYPE_PREFIXES.some(prefix =>
    normalized.startsWith(prefix)
  );
}

/**
 * Sanitizes a content type by blocking dangerous types.
 *
 * @param contentType - Raw content type from user input
 * @returns Safe content type or application/octet-stream fallback
 *
 * @example
 * sanitizeContentType('text/html') // 'application/octet-stream'
 * sanitizeContentType('image/jpeg') // 'image/jpeg'
 * sanitizeContentType(undefined) // 'application/octet-stream'
 */
export function sanitizeContentType(contentType: string | undefined): string {
  if (!contentType) {
    return SAFE_FALLBACK_CONTENT_TYPE;
  }

  const trimmed = contentType.trim();
  if (trimmed === '') {
    return SAFE_FALLBACK_CONTENT_TYPE;
  }

  // Normalize: lowercase, take only type/subtype (ignore parameters)
  const normalized = trimmed.toLowerCase().split(';')[0].trim();

  if (isDangerousContentType(normalized)) {
    return SAFE_FALLBACK_CONTENT_TYPE;
  }

  return normalized;
}

// ============================================================================
// RETENTION & TTL CONSTANTS
// ============================================================================

/**
 * Central retention period in days.
 * This value governs:
 * - S3 lifecycle rule for aborting incomplete multipart uploads
 * - Idempotency window for duplicate upload detection
 * - Download link expiry in completion emails
 *
 * Changing this single value updates all related timeouts consistently.
 */
export const RETENTION_DAYS = 7;

/** Idempotency window in hours (derived from RETENTION_DAYS) */
export const IDEMPOTENCY_TTL_HOURS = RETENTION_DAYS * 24;

/** Download link expiry in seconds (derived from RETENTION_DAYS) */
export const DOWNLOAD_LINK_EXPIRY_SECONDS = RETENTION_DAYS * 24 * 60 * 60;

/**
 * Generates a deterministic idempotency key from upload parameters.
 *
 * Uses djb2 hashing for fast, deterministic key generation.
 * Not cryptographic, but collisions only cause idempotent behavior (safe).
 * The key is derived from email + fileName + fileSize with length-prefixed
 * delimiters to prevent ambiguous parsing.
 *
 * @param email - Submitter's email address
 * @param fileName - Sanitized filename (MUST be post-sanitization)
 * @param fileSize - File size in bytes
 * @returns A 32-character hex string suitable for S3 paths
 *
 * @example
 * generateIdempotencyKey('user@example.com', 'file.pdf', 1024)
 * // => 'a1b2c3d4e5f6...' (32 hex chars)
 */
export function generateIdempotencyKey(
  email: string,
  fileName: string,
  fileSize: number
): string {
  // Use pipe delimiter with length prefixes to prevent collision attacks
  // e.g., "user|file" vs "user|" + "file" would otherwise collide
  const input = `${email.length}:${email}|${fileName.length}:${fileName}|${fileSize}`;
  return hashString(input);
}

/**
 * Simple deterministic hash for idempotency keys.
 * Uses djb2 algorithm - works in both browser and Node.js.
 *
 * Not cryptographic, but collisions only cause idempotent behavior (safe).
 *
 * @param input - String to hash
 * @returns 32-character hex string
 */
function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
    hash = hash >>> 0; // Convert to unsigned 32-bit
  }
  // Generate more entropy by hashing from both ends
  let hash2 = 5381;
  for (let i = input.length - 1; i >= 0; i--) {
    hash2 = ((hash2 << 5) + hash2) ^ input.charCodeAt(i);
    hash2 = hash2 >>> 0;
  }
  // Combine with length for additional uniqueness
  const combined = (hash ^ (hash2 << 1) ^ input.length) >>> 0;
  return hash.toString(16).padStart(8, '0') +
         hash2.toString(16).padStart(8, '0') +
         combined.toString(16).padStart(8, '0') +
         (hash ^ hash2).toString(16).padStart(8, '0');
}

/**
 * Converts an idempotency key to an S3 metadata file path.
 *
 * @param idempotencyKey - Key from generateIdempotencyKey()
 * @returns S3 key for the idempotency metadata file
 */
export function getIdempotencyMetadataKey(idempotencyKey: string): string {
  return `uploads/_idempotency/${idempotencyKey}_metadata.json`;
}

/**
 * Checks if an upload is still within the idempotency window.
 *
 * @param createdAt - ISO 8601 timestamp from metadata
 * @returns true if upload is still active (within TTL)
 */
export function isUploadStillActive(createdAt: string): boolean {
  const created = new Date(createdAt).getTime();
  const now = Date.now();
  const ttlMs = IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000;

  return (now - created) < ttlMs;
}
