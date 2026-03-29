/**
 * Test fixture builders for Lambda handler tests
 */

import type { GetObjectCommandOutput } from '@aws-sdk/client-s3';
import type { Logger } from '../handler';

// === LAMBDA EVENT BUILDERS ===

export interface LambdaEvent {
  rawPath: string;
  body?: string;
  requestContext: {
    http: {
      method: string;
    };
  };
}

export function createLambdaEvent(
  path: string,
  method: string = 'POST',
  body?: unknown
): LambdaEvent {
  return {
    rawPath: `/api${path}`,
    body: body ? JSON.stringify(body) : undefined,
    requestContext: {
      http: {
        method,
      },
    },
  };
}

// === REQUEST BODY BUILDERS ===

export interface InitiateRequestData {
  email?: string;
  title?: string;
  description?: string;
  fileName?: string;
  fileSize?: number;
  contentType?: string;
}

export function createInitiateRequest(
  overrides: Partial<InitiateRequestData> = {}
): InitiateRequestData {
  return {
    email: 'test@example.com',
    title: 'Test File',
    description: 'Test description',
    fileName: 'test.pdf',
    fileSize: 104857600, // 100MB
    contentType: 'application/pdf',
    ...overrides,
  };
}

export interface PresignRequestData {
  uploadId?: string;
  key?: string;
  partNumbers?: number[];
}

export function createPresignRequest(
  overrides: Partial<PresignRequestData> = {}
): PresignRequestData {
  return {
    uploadId: 'test-upload-id-12345',
    key: 'uploads/test-submission-id/test.pdf',
    partNumbers: [1, 2, 3],
    ...overrides,
  };
}

export interface CompletePart {
  PartNumber: number;
  ETag: string;
}

export interface CompleteRequestData {
  uploadId?: string;
  key?: string;
  parts?: CompletePart[];
  submissionId?: string;
}

export function createCompleteRequest(
  overrides: Partial<CompleteRequestData> = {}
): CompleteRequestData {
  return {
    uploadId: 'test-upload-id-12345',
    key: 'uploads/550e8400-e29b-41d4-a716-446655440000/test.pdf',
    parts: [
      { PartNumber: 1, ETag: 'etag-1' },
      { PartNumber: 2, ETag: 'etag-2' },
      { PartNumber: 3, ETag: 'etag-3' },
    ],
    submissionId: '550e8400-e29b-41d4-a716-446655440000',
    ...overrides,
  };
}

export interface AbortRequestData {
  uploadId?: string;
  key?: string;
  submissionId?: string;
}

export function createAbortRequest(
  overrides: Partial<AbortRequestData> = {}
): AbortRequestData {
  return {
    uploadId: 'test-upload-id-12345',
    key: 'uploads/550e8400-e29b-41d4-a716-446655440000/test.pdf',
    submissionId: '550e8400-e29b-41d4-a716-446655440000',
    ...overrides,
  };
}

export interface StatusRequestData {
  uploadId?: string;
  key?: string;
}

export function createStatusRequest(
  overrides: Partial<StatusRequestData> = {}
): StatusRequestData {
  return {
    uploadId: 'test-upload-id-12345',
    key: 'uploads/test-submission-id/test.pdf',
    ...overrides,
  };
}

// === MOCK AWS RESPONSE BUILDERS ===

export function createMockMultipartUploadResponse(uploadId: string = 'mock-upload-id') {
  return {
    UploadId: uploadId,
    Bucket: 'test-bucket',
    Key: 'test-key',
  };
}

export function createMockPutObjectResponse() {
  return {
    ETag: '"mock-etag"',
    VersionId: 'mock-version',
  };
}

export function createMockCompleteMultipartUploadResponse() {
  return {
    Location: 'https://test-bucket.s3.amazonaws.com/test-key',
    Bucket: 'test-bucket',
    Key: 'test-key',
    ETag: '"mock-complete-etag"',
  };
}

export function createMockListPartsResponse(partCount: number = 3, isTruncated: boolean = false) {
  const parts = [];
  for (let i = 1; i <= partCount; i++) {
    parts.push({
      PartNumber: i,
      ETag: `"etag-${i}"`,
      Size: 67108864, // 64MB
      LastModified: new Date(),
    });
  }
  return {
    Parts: parts,
    Bucket: 'test-bucket',
    Key: 'test-key',
    UploadId: 'test-upload-id',
    IsTruncated: isTruncated,
    NextPartNumberMarker: isTruncated ? String(partCount) : undefined,
  };
}

/**
 * Creates a mock GetObjectCommandOutput with a transformable body.
 *
 * The AWS SDK's streaming body types are complex and designed for real I/O.
 * For testing, we only need the transformToString() method that our handler uses.
 * This cast is safe because:
 * 1. Our handler only calls Body.transformToString()
 * 2. aws-sdk-client-mock intercepts the call before real SDK validation
 * 3. The mock is only used in test context
 */
export function createMockGetObjectResponse(
  metadata: unknown
): Partial<GetObjectCommandOutput> {
  const mockBody = {
    transformToString: async () => JSON.stringify(metadata),
  };

  return {
    Body: mockBody as GetObjectCommandOutput['Body'],
    ContentType: 'application/json',
    $metadata: {
      httpStatusCode: 200,
      requestId: 'mock-request-id',
      attempts: 1,
      totalRetryDelay: 0,
    },
  };
}

export function createMockSNSPublishResponse(messageId: string = 'mock-message-id') {
  return {
    MessageId: messageId,
  };
}

// === METADATA BUILDERS ===

export function createMetadata(overrides: Record<string, unknown> = {}) {
  return {
    email: 'test@example.com',
    title: 'Test File',
    description: 'Test description',
    fileName: 'test.pdf',
    fileSize: 104857600,
    contentType: 'application/pdf',
    submissionId: '550e8400-e29b-41d4-a716-446655440000',
    uploadId: 'test-upload-id-12345',
    key: 'uploads/550e8400-e29b-41d4-a716-446655440000/test.pdf',
    createdAt: new Date().toISOString(),
    idempotencyKey: 'test_example.com_test.pdf_104857600',
    ...overrides,
  };
}

// === EDGE CASE DATA ===

export function createLargePartNumbersArray(count: number = 100): number[] {
  return Array.from({ length: count }, (_, i) => i + 1);
}

// === TEST CONFIG ===

export function createTestConfig() {
  return {
    bucketName: 'test-bucket',
    snsTopicArn: 'arn:aws:sns:us-east-1:123456789012:test-topic',
    maxPartNumbers: 100,
  };
}

// === MOCK LOGGER ===

/**
 * Creates a silent mock logger for tests.
 * All methods are jest mocks that do nothing by default.
 */
export function createMockLogger(): Logger {
  return {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    setRequestId: jest.fn(),
  };
}
