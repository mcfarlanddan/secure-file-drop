/**
 * Idempotency service for upload deduplication
 *
 * Uses S3 HEAD/GET requests to check for existing uploads.
 * No new infrastructure required (no DynamoDB).
 */

import { S3Client, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { z } from 'zod';
import {
  generateIdempotencyKey,
  getIdempotencyMetadataKey,
  isUploadStillActive,
  UploadMetadata,
} from '../shared';

/**
 * Zod schema for validating UploadMetadata from S3.
 * Ensures corrupted or incompatible metadata doesn't cause runtime errors.
 */
const UploadMetadataSchema = z.object({
  email: z.string(),
  title: z.string(),
  description: z.string(),
  fileName: z.string(),
  fileSize: z.number(),
  contentType: z.string(),
  submissionId: z.string(),
  uploadId: z.string(),
  key: z.string(),
  createdAt: z.string(),
  idempotencyKey: z.string().optional(),
});

/**
 * Logger interface for dependency injection.
 */
export interface Logger {
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
  error: (message: string, data?: Record<string, unknown>) => void;
}

/**
 * Result of an idempotency check
 */
export interface IdempotencyCheckResult {
  /** Whether a matching upload exists and is still active */
  exists: boolean;
  /** Metadata of the existing upload (if exists) */
  uploadMetadata?: UploadMetadata;
  /** The idempotency key that was checked */
  idempotencyKey: string;
}

/**
 * Service for checking upload idempotency using S3 metadata files.
 *
 * When a user initiates an upload, we store metadata at two locations:
 * 1. uploads/{submissionId}/_metadata.json (for completion notifications)
 * 2. uploads/_idempotency/{key}_metadata.json (for duplicate detection)
 *
 * The idempotency key is derived from email + fileName + fileSize,
 * ensuring the same file from the same user returns the existing upload.
 */
export class IdempotencyService {
  constructor(
    private s3: S3Client,
    private bucketName: string,
    private logger: Logger
  ) {}

  /**
   * Checks if an upload with the same parameters already exists.
   *
   * Returns existing upload info if:
   * 1. Metadata file exists in S3
   * 2. Upload is still within TTL window (RETENTION_DAYS)
   * 3. Upload is still in-progress (not completed/aborted)
   *
   * @param email - Submitter's email
   * @param fileName - Sanitized filename
   * @param fileSize - File size in bytes
   * @returns IdempotencyCheckResult with existence status and metadata
   */
  async checkExistingUpload(
    email: string,
    fileName: string,
    fileSize: number
  ): Promise<IdempotencyCheckResult> {
    const idempotencyKey = generateIdempotencyKey(email, fileName, fileSize);
    const metadataKey = getIdempotencyMetadataKey(idempotencyKey);

    this.logger.info('Checking idempotency', {
      idempotencyKey,
      email,
      fileName,
      fileSize,
    });

    try {
      // First, check if metadata exists (fast HEAD request)
      await this.s3.send(new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: metadataKey,
      }));

      // Metadata exists, fetch full content
      const getResult = await this.s3.send(new GetObjectCommand({
        Bucket: this.bucketName,
        Key: metadataKey,
      }));

      if (!getResult.Body) {
        this.logger.warn('Empty idempotency metadata response from S3', { idempotencyKey });
        return { exists: false, idempotencyKey };
      }

      const metadataJson = await getResult.Body.transformToString();
      const parseResult = UploadMetadataSchema.safeParse(JSON.parse(metadataJson));

      if (!parseResult.success) {
        this.logger.warn('Invalid metadata format in S3', {
          idempotencyKey,
          errors: parseResult.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
        });
        return { exists: false, idempotencyKey };
      }

      const metadata: UploadMetadata = parseResult.data;

      // Validate TTL
      if (!isUploadStillActive(metadata.createdAt)) {
        this.logger.info('Idempotent upload expired', {
          idempotencyKey,
          createdAt: metadata.createdAt,
        });
        return { exists: false, idempotencyKey };
      }

      // Active upload found
      this.logger.info('Idempotent upload found', {
        idempotencyKey,
        submissionId: metadata.submissionId,
        uploadId: metadata.uploadId,
      });

      return {
        exists: true,
        uploadMetadata: metadata,
        idempotencyKey,
      };
    } catch (error: unknown) {
      // NoSuchKey or NotFound = no existing upload
      const errorName = (error as { name?: string }).name;
      const isNotFound = errorName === 'NoSuchKey' || errorName === 'NotFound';

      if (isNotFound) {
        this.logger.info('No idempotent upload found', { idempotencyKey });
        return { exists: false, idempotencyKey };
      }

      // Other errors should propagate (but log them)
      this.logger.error('Idempotency check failed', {
        error: String(error),
        idempotencyKey,
      });

      // Fail open - allow upload to proceed if check fails
      return { exists: false, idempotencyKey };
    }
  }
}
