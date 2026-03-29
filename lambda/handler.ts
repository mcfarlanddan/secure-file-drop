import {
  S3Client,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import {
  formatBytes,
  UploadMetadata,
  MAX_FILENAME_LENGTH,
  MAX_FILE_SIZE,
  MAX_S3_PART_NUMBER,
  MAX_S3_KEY_LENGTH,
  MAX_EMAIL_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_CONTENT_TYPE_LENGTH,
  S3_LIST_PARTS_MAX_KEYS,
  calculateChunkSize,
  sanitizeContentType,
  getIdempotencyMetadataKey,
  ErrorCode,
  ApiError,
  RETENTION_DAYS,
  DOWNLOAD_LINK_EXPIRY_SECONDS,
} from '../shared';
import { IdempotencyService } from './idempotency-service';
import { getConfig, type HandlerConfig } from './config';
import { withRetry } from './retry';

// Re-export for consumers
export type { HandlerConfig } from './config';

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Maximum parts to retrieve during status pagination.
 * S3 multipart uploads support max 10,000 parts, but we add buffer for safety.
 */
const MAX_STATUS_PARTS_LIMIT = 100_000;

// HandlerConfig is now imported from ./config

/**
 * Structured log entry for CloudWatch Logs Insights queries.
 */
interface LogEntry {
  level: 'INFO' | 'WARN' | 'ERROR';
  message: string;
  requestId?: string;
  path?: string;
  [key: string]: unknown;
}

/**
 * Logger interface for dependency injection.
 * Production logger outputs structured JSON for CloudWatch.
 */
export interface Logger {
  error: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
  info: (message: string, data?: Record<string, unknown>) => void;
  setRequestId: (requestId: string) => void;
}

/**
 * Creates a structured JSON logger for CloudWatch Logs Insights.
 */
function createStructuredLogger(): Logger {
  let currentRequestId: string | undefined;

  const log = (level: LogEntry['level'], message: string, data?: Record<string, unknown>) => {
    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      requestId: currentRequestId,
      ...data,
    };
    console.log(JSON.stringify(entry));
  };

  return {
    info: (message, data) => log('INFO', message, data),
    warn: (message, data) => log('WARN', message, data),
    error: (message, data) => log('ERROR', message, data),
    setRequestId: (requestId: string) => { currentRequestId = requestId; },
  };
}

export interface HandlerDependencies {
  s3: S3Client;
  sns: SNSClient;
  config: HandlerConfig;
  logger: Logger;
}

/**
 * Gets validated configuration from environment variables.
 * Throws ConfigValidationError at startup if config is invalid.
 */
function getDefaultConfig(): HandlerConfig {
  return getConfig();
}

function createDefaultDependencies(): HandlerDependencies {
  return {
    // Disable automatic checksum calculation for presigned URLs
    // AWS SDK v3.629+ adds CRC32 checksums by default, but browsers can't
    // compute and include the checksum header when uploading via presigned URLs
    s3: new S3Client({
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    }),
    sns: new SNSClient({}),
    config: getDefaultConfig(),
    logger: createStructuredLogger(),
  };
}

// ============================================================================
// VALIDATION
// ============================================================================

/** Fallback filename when original is invalid or hidden */
const FALLBACK_FILENAME = 'untitled_file';

/**
 * Sanitizes a filename to prevent path traversal and injection attacks.
 * Removes path components, dangerous characters, and hidden file prefixes.
 *
 * @param fileName - The original filename to sanitize
 * @returns A safe filename suitable for S3 storage
 */
export function sanitizeFileName(fileName: string): string {
  // Extract basename (remove path components)
  const baseName = fileName.split('/').pop()?.split('\\').pop() || FALLBACK_FILENAME;

  // Remove dangerous characters, keep safe ones
  const sanitized = baseName
    .replace(/[^a-zA-Z0-9._\- ]/g, '_')
    .slice(0, MAX_FILENAME_LENGTH);

  // Prevent hidden files and parent directory references
  if (sanitized.startsWith('.') || sanitized === '..' || sanitized === '') {
    return FALLBACK_FILENAME;
  }

  return sanitized;
}

const InitiateRequestSchema = z.object({
  email: z.string().email().max(MAX_EMAIL_LENGTH),
  title: z.string().max(MAX_TITLE_LENGTH).optional(),
  description: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
  fileName: z.string().min(1).max(MAX_FILENAME_LENGTH).transform(sanitizeFileName),
  fileSize: z.number().int().positive().max(MAX_FILE_SIZE),
  // Content type is sanitized in the schema to block dangerous MIME types
  // Optional input, transform handles undefined by using empty string fallback
  contentType: z
    .string()
    .max(MAX_CONTENT_TYPE_LENGTH)
    .optional()
    .transform((val): string => sanitizeContentType(val ?? '')),
});

const PresignRequestSchema = z.object({
  uploadId: z.string().min(1),
  key: z.string().min(1).max(MAX_S3_KEY_LENGTH),
  partNumbers: z.array(z.number().int().positive().max(MAX_S3_PART_NUMBER)).min(1),
});

const CompleteRequestSchema = z.object({
  uploadId: z.string().min(1),
  key: z.string().min(1).max(MAX_S3_KEY_LENGTH),
  parts: z.array(z.object({
    PartNumber: z.number().int().positive().max(MAX_S3_PART_NUMBER),
    ETag: z.string().min(1),
  })).min(1).max(MAX_S3_PART_NUMBER).refine(
    (parts) => {
      const partNumbers = parts.map(p => p.PartNumber);
      return new Set(partNumbers).size === partNumbers.length;
    },
    { message: 'Duplicate part numbers are not allowed' }
  ),
  submissionId: z.string().uuid(),
});

const AbortRequestSchema = z.object({
  uploadId: z.string().min(1),
  key: z.string().min(1).max(MAX_S3_KEY_LENGTH),
  submissionId: z.string().uuid().optional(),
});

const StatusRequestSchema = z.object({
  uploadId: z.string().min(1),
  key: z.string().min(1).max(MAX_S3_KEY_LENGTH),
});

/**
 * Validates a request body against a Zod schema.
 * Returns either the validated data or a descriptive error message.
 */
function validateRequest<T>(
  schema: z.ZodSchema<T>,
  body: unknown
): { success: true; data: T } | { success: false; error: string } {
  try {
    const data = schema.parse(body);
    return { success: true, data };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
      };
    }
    return { success: false, error: String(error) };
  }
}

// ============================================================================
// TYPES
// ============================================================================

interface LambdaEvent {
  rawPath: string;
  body?: string;
  requestContext: {
    requestId?: string;
    http: {
      method: string;
    };
  };
}

interface ApiResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

// ============================================================================
// RESPONSE HELPERS
// ============================================================================

/**
 * Standard CORS headers.
 *
 * Uses '*' for Access-Control-Allow-Origin because this API has no ambient
 * credentials (no cookies, no sessions, no auth tokens). Without ambient
 * credentials, CORS provides no security value - an attacker's server can
 * make identical requests to what a browser can. The actual security comes
 * from presigned URLs (cryptographically authenticated) and input validation.
 *
 * See SECURITY.md for full threat analysis.
 */
function getCorsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function response(
  statusCode: number,
  body: unknown,
  requestId?: string
): ApiResponse {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'X-Request-Id': requestId || 'unknown',
      ...getCorsHeaders(),
    },
    body: JSON.stringify(body),
  };
}

/**
 * Creates a structured error response with error code.
 */
function errorResponse(
  statusCode: number,
  code: ErrorCode,
  message: string,
  requestId?: string,
  details?: string
): ApiResponse {
  const body: ApiError = {
    code,
    error: message,
    requestId: requestId || 'unknown',
  };
  if (details) {
    body.details = details;
  }
  return response(statusCode, body, requestId);
}

function corsPreflightResponse(): ApiResponse {
  return {
    statusCode: 200,
    headers: getCorsHeaders(),
    body: '',
  };
}

// ============================================================================
// ERROR HANDLING
// ============================================================================

interface S3Error {
  name: string;
  message?: string;
}

function isS3Error(error: unknown): error is S3Error {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof (error as S3Error).name === 'string'
  );
}

// ============================================================================
// UPLOAD SERVICE
// ============================================================================

export class UploadService {
  private requestId: string = 'unknown';
  private idempotencyService: IdempotencyService;

  constructor(
    private s3: S3Client,
    private sns: SNSClient,
    private config: HandlerConfig,
    private logger: Logger
  ) {
    this.idempotencyService = new IdempotencyService(s3, config.bucketName, logger);
  }

  async handle(event: LambdaEvent): Promise<ApiResponse> {
    const path = event.rawPath.replace('/api', '');
    const method = event.requestContext.http.method;

    // Extract or generate request ID for tracing
    this.requestId = event.requestContext.requestId || randomUUID();
    if (this.logger.setRequestId) {
      this.logger.setRequestId(this.requestId);
    }

    this.logger.info('Request received', { path, method });

    if (method === 'OPTIONS') {
      return corsPreflightResponse();
    }

    try {
      const body = event.body ? JSON.parse(event.body) : {};

      switch (path) {
        case '/initiate':
          return await this.initiateUpload(body);
        case '/presign':
          return await this.presignParts(body);
        case '/complete':
          return await this.completeUpload(body);
        case '/abort':
          return await this.abortUpload(body);
        case '/status':
          return await this.getStatus(body);
        case '/health':
          return this.healthCheck();
        default:
          return this.errorResponse(404, ErrorCode.NOT_FOUND, `Endpoint not found: ${path}`);
      }
    } catch (error) {
      this.logger.error('Handler error', { error: String(error), stack: (error as Error)?.stack });
      return this.errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error');
    }
  }

  /**
   * Creates an error response with request ID.
   */
  private errorResponse(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details?: string
  ): ApiResponse {
    return errorResponse(statusCode, code, message, this.requestId, details);
  }

  /**
   * Creates a success response with request ID.
   */
  private successResponse(statusCode: number, body: unknown): ApiResponse {
    return response(statusCode, body, this.requestId);
  }

  private healthCheck(): ApiResponse {
    return this.successResponse(200, {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      requestId: this.requestId,
    });
  }

  private async initiateUpload(body: unknown): Promise<ApiResponse> {
    const validation = validateRequest(InitiateRequestSchema, body);
    if (!validation.success) {
      this.logger.warn('Validation failed', { details: validation.error });
      return this.errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Validation failed', validation.error);
    }

    // Extract validated fields
    // Note: contentType transform always returns string, but TypeScript infers string | undefined
    // from optional(). The ?? is defensive but will never be used since transform handles it.
    const { email, title, description, fileName, fileSize, contentType: rawContentType } = validation.data;
    const contentType = rawContentType ?? 'application/octet-stream';

    // Calculate optimal chunk size based on file size (dynamic scaling for 5TB support)
    const chunkSize = calculateChunkSize(fileSize);
    const totalParts = Math.ceil(fileSize / chunkSize);

    // ========================================================================
    // IDEMPOTENCY CHECK
    // ========================================================================
    const idempotencyCheck = await this.idempotencyService.checkExistingUpload(
      email,
      fileName,
      fileSize
    );

    if (idempotencyCheck.exists && idempotencyCheck.uploadMetadata) {
      // Return existing upload info (idempotent response)
      const existing = idempotencyCheck.uploadMetadata;
      const existingChunkSize = calculateChunkSize(existing.fileSize);
      const existingTotalParts = Math.ceil(existing.fileSize / existingChunkSize);

      this.logger.info('Returning idempotent upload', {
        submissionId: existing.submissionId,
        uploadId: existing.uploadId,
      });

      return this.successResponse(200, {
        submissionId: existing.submissionId,
        uploadId: existing.uploadId,
        key: existing.key,
        totalParts: existingTotalParts,
        chunkSize: existingChunkSize,
        idempotent: true,
      });
    }

    // ========================================================================
    // NEW UPLOAD
    // ========================================================================
    const submissionId = randomUUID();
    const key = `uploads/${submissionId}/${fileName}`;
    const idempotencyKey = idempotencyCheck.idempotencyKey;

    this.logger.info('Initiating multipart upload', {
      submissionId,
      fileName,
      fileSize,
      chunkSize,
      totalParts,
    });

    const { UploadId } = await withRetry(
      () => this.s3.send(new CreateMultipartUploadCommand({
        Bucket: this.config.bucketName,
        Key: key,
        ContentType: contentType,
      })),
      'CreateMultipartUpload',
      this.logger
    );

    const metadata: UploadMetadata = {
      email,
      title: title || fileName,
      description: description || '',
      fileName,
      fileSize,
      contentType,
      submissionId,
      uploadId: UploadId!,
      key,
      createdAt: new Date().toISOString(),
      idempotencyKey,
    };

    // ========================================================================
    // RACE CONDITION PREVENTION
    // ========================================================================
    // Use conditional write (If-None-Match: *) for idempotency metadata.
    // If another request created this file between our check and now,
    // the write fails with PreconditionFailed and we return the existing upload.
    try {
      await this.s3.send(new PutObjectCommand({
        Bucket: this.config.bucketName,
        Key: getIdempotencyMetadataKey(idempotencyKey),
        Body: JSON.stringify(metadata),
        ContentType: 'application/json',
        // Conditional write: only succeed if object doesn't exist
        IfNoneMatch: '*',
      }));
    } catch (error: unknown) {
      // Check if this is a PreconditionFailed error (another request won the race)
      if (isS3Error(error) && (error.name === 'PreconditionFailed' || error.name === '412')) {
        this.logger.info('Race condition detected, aborting our upload and returning existing', {
          submissionId,
          idempotencyKey,
        });

        // Abort the multipart upload we just created
        try {
          await this.s3.send(new AbortMultipartUploadCommand({
            Bucket: this.config.bucketName,
            Key: key,
            UploadId: UploadId,
          }));
        } catch (abortError) {
          this.logger.warn('Failed to abort duplicate upload', { error: String(abortError) });
        }

        // Re-read the existing upload that won the race
        const existingCheck = await this.idempotencyService.checkExistingUpload(
          email,
          fileName,
          fileSize
        );

        if (existingCheck.exists && existingCheck.uploadMetadata) {
          const existing = existingCheck.uploadMetadata;
          const existingChunkSize = calculateChunkSize(existing.fileSize);
          const existingTotalParts = Math.ceil(existing.fileSize / existingChunkSize);

          return this.successResponse(200, {
            submissionId: existing.submissionId,
            uploadId: existing.uploadId,
            key: existing.key,
            totalParts: existingTotalParts,
            chunkSize: existingChunkSize,
            idempotent: true,
          });
        }

        // If we still can't find it, something is wrong - fail gracefully
        throw new Error('Race condition recovery failed: existing upload not found');
      }
      // Re-throw other errors
      throw error;
    }

    // Successfully claimed the idempotency key - store the primary metadata
    await withRetry(
      () => this.s3.send(new PutObjectCommand({
        Bucket: this.config.bucketName,
        Key: `uploads/${submissionId}/_metadata.json`,
        Body: JSON.stringify(metadata),
        ContentType: 'application/json',
      })),
      'PutMetadata',
      this.logger
    );

    this.logger.info('Upload initiated successfully', { submissionId, totalParts });

    return this.successResponse(200, {
      submissionId,
      uploadId: UploadId,
      key,
      totalParts,
      chunkSize,
    });
  }

  private async presignParts(body: unknown): Promise<ApiResponse> {
    const validation = validateRequest(PresignRequestSchema, body);
    if (!validation.success) {
      return this.errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Validation failed', validation.error);
    }

    const { uploadId, key, partNumbers } = validation.data;

    if (partNumbers.length > this.config.maxPartNumbers) {
      return this.errorResponse(
        400,
        ErrorCode.TOO_MANY_PARTS,
        `Too many part numbers requested. Maximum is ${this.config.maxPartNumbers}`
      );
    }

    const urls = await Promise.all(
      partNumbers.map(async (partNumber) => {
        const command = new UploadPartCommand({
          Bucket: this.config.bucketName,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        });

        const url = await getSignedUrl(this.s3, command, { expiresIn: 3600 });
        return { partNumber, url };
      })
    );

    return this.successResponse(200, { urls });
  }

  private async completeUpload(body: unknown): Promise<ApiResponse> {
    const validation = validateRequest(CompleteRequestSchema, body);
    if (!validation.success) {
      return this.errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Validation failed', validation.error);
    }

    const { uploadId, key, parts, submissionId } = validation.data;

    this.logger.info('Completing multipart upload', { submissionId, partCount: parts.length });

    await withRetry(
      () => this.s3.send(new CompleteMultipartUploadCommand({
        Bucket: this.config.bucketName,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.sort((a, b) => a.PartNumber - b.PartNumber),
        },
      })),
      'CompleteMultipartUpload',
      this.logger
    );

    // Read metadata for notification
    const metadata = await this.readMetadata(submissionId);

    // Generate presigned download URL with content-disposition for proper filename
    const downloadUrl = await this.generateDownloadUrl(key, metadata.fileName);

    // Send notification - don't fail the upload if notification fails
    // The S3 upload is already complete at this point
    let notificationSent = true;
    try {
      await withRetry(
        () => this.sns.send(new PublishCommand({
          TopicArn: this.config.snsTopicArn,
          Subject: `[Secure File Drop] Upload complete: ${metadata.title}`,
          Message: [
            'Upload completed successfully!',
            '',
            `From: ${metadata.email}`,
            `File: ${metadata.fileName}`,
            `Size: ${formatBytes(metadata.fileSize)}`,
            `Title: ${metadata.title}`,
            `Description: ${metadata.description || 'N/A'}`,
            '',
            `📥 Download Link (expires in ${RETENTION_DAYS} days):`,
            downloadUrl,
            '',
            `Location: s3://${this.config.bucketName}/${key}`,
            `Submission ID: ${submissionId}`,
            `Request ID: ${this.requestId}`,
          ].join('\n'),
        })),
        'SNSPublish',
        this.logger
      );
    } catch (snsError) {
      // Log the error but don't fail the request - upload already succeeded
      this.logger.error('Failed to send SNS notification', {
        submissionId,
        error: String(snsError),
        stack: (snsError as Error)?.stack,
      });
      notificationSent = false;
    }

    // Delete metadata after successful completion
    await this.deleteMetadata(submissionId);

    // Also delete idempotency metadata
    if (metadata.idempotencyKey) {
      await this.deleteIdempotencyMetadata(metadata.idempotencyKey);
    }

    this.logger.info('Upload completed successfully', { submissionId, notificationSent });

    return this.successResponse(200, {
      success: true,
      message: 'Upload completed successfully',
      notificationSent,
    });
  }

  private async abortUpload(body: unknown): Promise<ApiResponse> {
    const validation = validateRequest(AbortRequestSchema, body);
    if (!validation.success) {
      return this.errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Validation failed', validation.error);
    }

    const { uploadId, key, submissionId } = validation.data;

    this.logger.info('Aborting multipart upload', { submissionId, uploadId });

    await this.s3.send(new AbortMultipartUploadCommand({
      Bucket: this.config.bucketName,
      Key: key,
      UploadId: uploadId,
    }));

    if (submissionId) {
      // Read metadata first to get idempotency key, then delete both
      const metadata = await this.readMetadata(submissionId);
      await this.deleteMetadata(submissionId);

      // Also delete idempotency metadata
      if (metadata.idempotencyKey) {
        await this.deleteIdempotencyMetadata(metadata.idempotencyKey);
      }
    }

    this.logger.info('Upload aborted', { submissionId });

    return this.successResponse(200, { success: true, message: 'Upload aborted' });
  }

  private async getStatus(body: unknown): Promise<ApiResponse> {
    const validation = validateRequest(StatusRequestSchema, body);
    if (!validation.success) {
      return this.errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Validation failed', validation.error);
    }

    const { uploadId, key } = validation.data;

    try {
      const allParts: Array<{ partNumber: number; etag: string; size: number }> = [];
      let partNumberMarker: string | undefined;
      let isTruncated = true;

      while (isTruncated) {
        const listResponse = await withRetry(
          () => this.s3.send(new ListPartsCommand({
            Bucket: this.config.bucketName,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: partNumberMarker,
            MaxParts: S3_LIST_PARTS_MAX_KEYS,
          })),
          'ListParts',
          this.logger
        );

        const parts = listResponse.Parts || [];

        // Filter parts with valid data (defensive - S3 API guarantees these, but be safe)
        const validParts = parts.filter(p =>
          p.PartNumber !== undefined && p.ETag !== undefined && p.Size !== undefined
        );

        if (validParts.length !== parts.length) {
          this.logger.warn('Skipped parts with missing fields', {
            total: parts.length,
            valid: validParts.length,
          });
        }

        allParts.push(...validParts.map(p => ({
          partNumber: p.PartNumber as number,
          etag: p.ETag as string,
          size: p.Size as number,
        })));

        isTruncated = listResponse.IsTruncated || false;
        partNumberMarker = listResponse.NextPartNumberMarker;

        // Safety limit to prevent infinite loops
        if (allParts.length > MAX_STATUS_PARTS_LIMIT) {
          this.logger.warn('Exceeded parts limit, stopping pagination', { limit: MAX_STATUS_PARTS_LIMIT });
          break;
        }
      }

      return this.successResponse(200, {
        completedParts: allParts,
        totalParts: allParts.length,
      });
    } catch (error: unknown) {
      if (isS3Error(error) && error.name === 'NoSuchUpload') {
        return this.successResponse(200, {
          completedParts: [],
          status: 'completed_or_aborted',
          code: ErrorCode.UPLOAD_NOT_FOUND,
        });
      }
      throw error;
    }
  }

  // ===========================================================================
  // DOWNLOAD URL GENERATION
  // ===========================================================================

  /**
   * Generates a presigned download URL with content-disposition header.
   * This ensures the browser downloads with the correct filename.
   *
   * @param key - S3 object key
   * @param fileName - Original filename for content-disposition
   * @returns Presigned URL valid for DOWNLOAD_LINK_EXPIRY_SECONDS
   */
  private async generateDownloadUrl(key: string, fileName: string): Promise<string> {
    // Encode filename for content-disposition header (RFC 5987)
    const encodedFileName = encodeURIComponent(fileName).replace(/'/g, '%27');

    const command = new GetObjectCommand({
      Bucket: this.config.bucketName,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${fileName}"; filename*=UTF-8''${encodedFileName}`,
    });

    return getSignedUrl(this.s3, command, { expiresIn: DOWNLOAD_LINK_EXPIRY_SECONDS });
  }

  // ===========================================================================
  // METADATA HELPERS
  // ===========================================================================

  /**
   * Reads upload metadata from S3.
   * Returns a fallback object if metadata cannot be read.
   */
  private async readMetadata(submissionId: string): Promise<UploadMetadata> {
    const fallback: UploadMetadata = {
      email: 'unknown',
      title: 'Unknown',
      description: '',
      fileName: 'unknown',
      fileSize: 0,
      contentType: 'application/octet-stream',
      submissionId,
      uploadId: '',
      key: '',
      createdAt: new Date().toISOString(),
      idempotencyKey: undefined,
    };

    try {
      const result = await this.s3.send(new GetObjectCommand({
        Bucket: this.config.bucketName,
        Key: `uploads/${submissionId}/_metadata.json`,
      }));

      if (!result.Body) {
        this.logger.warn('Empty metadata response from S3', { submissionId });
        return fallback;
      }

      const content = await result.Body.transformToString();
      return JSON.parse(content) as UploadMetadata;
    } catch (error) {
      this.logger.warn('Could not read metadata', { submissionId, error: String(error) });
      return fallback;
    }
  }

  /**
   * Deletes upload metadata from S3.
   * Logs a warning if deletion fails but does not throw.
   */
  private async deleteMetadata(submissionId: string): Promise<void> {
    try {
      await this.s3.send(new DeleteObjectCommand({
        Bucket: this.config.bucketName,
        Key: `uploads/${submissionId}/_metadata.json`,
      }));
    } catch (error) {
      this.logger.warn('Failed to delete metadata', { submissionId, error: String(error) });
      // Don't fail the operation if metadata cleanup fails
    }
  }

  /**
   * Deletes idempotency metadata from S3.
   * Logs a warning if deletion fails but does not throw.
   */
  private async deleteIdempotencyMetadata(idempotencyKey: string): Promise<void> {
    try {
      await this.s3.send(new DeleteObjectCommand({
        Bucket: this.config.bucketName,
        Key: getIdempotencyMetadataKey(idempotencyKey),
      }));
    } catch (error) {
      this.logger.warn('Failed to delete idempotency metadata', {
        idempotencyKey,
        error: String(error),
      });
      // Don't fail the operation if metadata cleanup fails
    }
  }
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

// Lambda passes (event, context) - we ignore context and use our own deps for testing
export async function handler(event: LambdaEvent, _context?: unknown, deps?: HandlerDependencies): Promise<ApiResponse> {
  // Use provided deps only if it has the expected shape (for testing)
  const dependencies = (deps && deps.config) ? deps : createDefaultDependencies();

  const service = new UploadService(
    dependencies.s3,
    dependencies.sns,
    dependencies.config,
    dependencies.logger
  );
  return service.handle(event);
}
