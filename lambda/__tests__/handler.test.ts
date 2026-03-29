import { mockClient } from 'aws-sdk-client-mock';
import {
  S3Client,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import type { UploadPartCommandInput } from '@aws-sdk/client-s3';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { handler, sanitizeFileName, HandlerDependencies } from '../handler';
import {
  createLambdaEvent,
  createInitiateRequest,
  createPresignRequest,
  createCompleteRequest,
  createAbortRequest,
  createStatusRequest,
  createMetadata,
  createMockMultipartUploadResponse,
  createMockPutObjectResponse,
  createMockCompleteMultipartUploadResponse,
  createMockListPartsResponse,
  createMockGetObjectResponse,
  createMockSNSPublishResponse,
  createLargePartNumbersArray,
  createTestConfig,
  createMockLogger,
} from './fixtures';

// Mock getSignedUrl
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

const mockGetSignedUrl = getSignedUrl as jest.MockedFunction<typeof getSignedUrl>;

// Create mock clients
const mockS3 = mockClient(S3Client);
const mockSNS = mockClient(SNSClient);

describe('handler', () => {
  let deps: HandlerDependencies;

  beforeEach(() => {
    mockS3.reset();
    mockSNS.reset();
    jest.clearAllMocks();

    deps = {
      s3: new S3Client({}),
      sns: new SNSClient({}),
      config: createTestConfig(),
      logger: createMockLogger(),
    };
  });

  describe('CORS Handling', () => {
    it('should return CORS headers for OPTIONS request', async () => {
      const event = createLambdaEvent('/initiate', 'OPTIONS');
      const response = await handler(event, undefined, deps);

      expect(response.statusCode).toBe(200);
      expect(response.headers).toMatchObject({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      expect(response.body).toBe('');
    });
  });

  describe('Routing', () => {
    it('should return 404 for unknown path', async () => {
      const event = createLambdaEvent('/unknown', 'POST', {});
      const response = await handler(event, undefined, deps);

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('NOT_FOUND');
      expect(body.error).toContain('/unknown');
    });

    it('should handle malformed JSON body', async () => {
      const event = {
        rawPath: '/api/initiate',
        body: '{ invalid json }',
        requestContext: { http: { method: 'POST' } },
      };
      const response = await handler(event, undefined, deps);

      expect(response.statusCode).toBe(500);
    });
  });

  describe('/initiate endpoint', () => {
    describe('Success Cases', () => {
      beforeEach(() => {
        mockS3.on(CreateMultipartUploadCommand).resolves(createMockMultipartUploadResponse('test-upload-id'));
        mockS3.on(PutObjectCommand).resolves(createMockPutObjectResponse());
        mockSNS.on(PublishCommand).resolves(createMockSNSPublishResponse());
      });

      it('should create multipart upload with valid input', async () => {
        const requestBody = createInitiateRequest();
        const event = createLambdaEvent('/initiate', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.uploadId).toBe('test-upload-id');
        expect(body.submissionId).toBeDefined();
        expect(body.key).toMatch(/^uploads\/.+\/test\.pdf$/);
        expect(body.totalParts).toBe(2); // 100MB / 64MB = 2 parts
        expect(body.chunkSize).toBe(67108864);
      });

      it('should store metadata in S3 (both idempotency and original locations)', async () => {
        const requestBody = createInitiateRequest({
          email: 'user@example.com',
          title: 'Important Document',
        });
        const event = createLambdaEvent('/initiate', 'POST', requestBody);

        await handler(event, undefined, deps);

        const putObjectCalls = mockS3.commandCalls(PutObjectCommand);
        // Metadata is stored in 2 locations:
        // 1. Idempotency location FIRST (with conditional write to prevent race conditions)
        // 2. Original location (for completion notification)
        expect(putObjectCalls.length).toBe(2);
        expect(putObjectCalls[0].args[0].input.Key).toMatch(/uploads\/_idempotency\/.*_metadata\.json$/);
        expect(putObjectCalls[1].args[0].input.Key).toMatch(/uploads\/.*\/_metadata\.json$/);
      });

      it('should not send SNS notification on upload start (only on complete)', async () => {
        const requestBody = createInitiateRequest({
          email: 'notify@example.com',
          fileName: 'report.pdf',
        });
        const event = createLambdaEvent('/initiate', 'POST', requestBody);

        await handler(event, undefined, deps);

        const snsCalls = mockSNS.commandCalls(PublishCommand);
        expect(snsCalls.length).toBe(0);
      });

      it('should handle optional title and description', async () => {
        const requestBody = createInitiateRequest({
          title: undefined,
          description: undefined,
        });
        const event = createLambdaEvent('/initiate', 'POST', requestBody);

        const response = await handler(event, undefined, deps);
        expect(response.statusCode).toBe(200);
      });

      it('should calculate totalParts correctly for various file sizes', async () => {
        const testCases = [
          { fileSize: 67108864, expectedParts: 1 }, // Exactly 64MB
          { fileSize: 67108865, expectedParts: 2 }, // 64MB + 1 byte
          { fileSize: 134217728, expectedParts: 2 }, // 128MB
          { fileSize: 1073741824, expectedParts: 16 }, // 1GB
        ];

        for (const { fileSize, expectedParts } of testCases) {
          mockS3.reset();
          mockSNS.reset();
          mockS3.on(CreateMultipartUploadCommand).resolves(createMockMultipartUploadResponse());
          mockS3.on(PutObjectCommand).resolves(createMockPutObjectResponse());
          mockSNS.on(PublishCommand).resolves(createMockSNSPublishResponse());

          const requestBody = createInitiateRequest({ fileSize });
          const event = createLambdaEvent('/initiate', 'POST', requestBody);
          const response = await handler(event, undefined, deps);

          const body = JSON.parse(response.body);
          expect(body.totalParts).toBe(expectedParts);
        }
      });
    });

    describe('Validation Errors', () => {
      it('should return 400 when email is missing', async () => {
        const requestBody = createInitiateRequest({ email: undefined });
        const event = createLambdaEvent('/initiate', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(400);
        const body = JSON.parse(response.body);
        expect(body.error).toBe('Validation failed');
      });

      it('should return 400 when email is invalid', async () => {
        const requestBody = createInitiateRequest({ email: 'not-an-email' });
        const event = createLambdaEvent('/initiate', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(400);
      });

      it('should return 400 when fileName is missing', async () => {
        const requestBody = createInitiateRequest({ fileName: undefined });
        const event = createLambdaEvent('/initiate', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(400);
      });

      it('should return 400 when fileSize is missing', async () => {
        const requestBody = createInitiateRequest({ fileSize: undefined });
        const event = createLambdaEvent('/initiate', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(400);
      });

      it('should return 400 when fileSize is negative', async () => {
        const requestBody = createInitiateRequest({ fileSize: -1 });
        const event = createLambdaEvent('/initiate', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(400);
      });
    });

    describe('AWS Errors', () => {
      it('should return 500 when CreateMultipartUpload fails', async () => {
        mockS3.on(CreateMultipartUploadCommand).rejects(new Error('S3 error'));
        mockSNS.on(PublishCommand).resolves(createMockSNSPublishResponse());

        const requestBody = createInitiateRequest();
        const event = createLambdaEvent('/initiate', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(500);
      });

      it('should return 500 when PutObject fails', async () => {
        mockS3.on(CreateMultipartUploadCommand).resolves(createMockMultipartUploadResponse());
        mockS3.on(PutObjectCommand).rejects(new Error('PutObject error'));

        const requestBody = createInitiateRequest();
        const event = createLambdaEvent('/initiate', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(500);
      });

      // Note: SNS is no longer called during /initiate - only on /complete
    });
  });

  describe('/presign endpoint', () => {
    describe('Success Cases', () => {
      beforeEach(() => {
        mockGetSignedUrl.mockImplementation(async (_client, command) => {
          const input = command.input as UploadPartCommandInput;
          const partNumber = input.PartNumber;
          return `https://test-bucket.s3.amazonaws.com/test-key?partNumber=${partNumber}`;
        });
      });

      it('should generate presigned URL for single part', async () => {
        const requestBody = createPresignRequest({ partNumbers: [1] });
        const event = createLambdaEvent('/presign', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.urls).toHaveLength(1);
        expect(body.urls[0].partNumber).toBe(1);
        expect(body.urls[0].url).toContain('partNumber=1');
      });

      it('should generate presigned URLs for multiple parts', async () => {
        const requestBody = createPresignRequest({ partNumbers: [1, 2, 3, 4, 5] });
        const event = createLambdaEvent('/presign', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.urls).toHaveLength(5);
      });

      it('should handle maximum allowed part numbers', async () => {
        const partNumbers = createLargePartNumbersArray(100);
        const requestBody = createPresignRequest({ partNumbers });
        const event = createLambdaEvent('/presign', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.urls).toHaveLength(100);
      });
    });

    describe('Validation Errors', () => {
      it('should return 400 when uploadId is missing', async () => {
        const requestBody = createPresignRequest({ uploadId: undefined });
        const event = createLambdaEvent('/presign', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(400);
      });

      it('should return 400 when key is missing', async () => {
        const requestBody = createPresignRequest({ key: undefined });
        const event = createLambdaEvent('/presign', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(400);
      });

      it('should return 400 when partNumbers is missing', async () => {
        const requestBody = createPresignRequest({ partNumbers: undefined });
        const event = createLambdaEvent('/presign', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(400);
      });

      it('should return 400 when partNumbers exceeds maximum', async () => {
        const partNumbers = createLargePartNumbersArray(150);
        const requestBody = createPresignRequest({ partNumbers });
        const event = createLambdaEvent('/presign', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(400);
        const body = JSON.parse(response.body);
        expect(body.error).toContain('Too many part numbers');
      });

      it('should return 400 when partNumbers is empty', async () => {
        const requestBody = createPresignRequest({ partNumbers: [] });
        const event = createLambdaEvent('/presign', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(400);
      });
    });

    describe('AWS Errors', () => {
      it('should return 500 when getSignedUrl fails', async () => {
        mockGetSignedUrl.mockRejectedValue(new Error('Signing failed'));

        const requestBody = createPresignRequest();
        const event = createLambdaEvent('/presign', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(500);
      });
    });
  });

  describe('/complete endpoint', () => {
    describe('Success Cases', () => {
      beforeEach(() => {
        mockS3.on(CompleteMultipartUploadCommand).resolves(createMockCompleteMultipartUploadResponse());
        mockS3.on(GetObjectCommand).resolves(createMockGetObjectResponse(createMetadata()));
        mockS3.on(DeleteObjectCommand).resolves({});
        mockSNS.on(PublishCommand).resolves(createMockSNSPublishResponse());
        // Mock getSignedUrl for download link generation
        mockGetSignedUrl.mockResolvedValue('https://test-bucket.s3.amazonaws.com/download-url');
      });

      it('should complete multipart upload', async () => {
        const requestBody = createCompleteRequest();
        const event = createLambdaEvent('/complete', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.success).toBe(true);
      });

      it('should send completion notification with metadata', async () => {
        const requestBody = createCompleteRequest();
        const event = createLambdaEvent('/complete', 'POST', requestBody);

        await handler(event, undefined, deps);

        const snsCalls = mockSNS.commandCalls(PublishCommand);
        expect(snsCalls.length).toBe(1);
        expect(snsCalls[0].args[0].input.Subject).toContain('Upload complete');
      });

      it('should handle metadata read failure gracefully', async () => {
        mockS3.on(GetObjectCommand).rejects(new Error('NoSuchKey'));

        const requestBody = createCompleteRequest();
        const event = createLambdaEvent('/complete', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(200);
      });

      it('should delete metadata after successful completion', async () => {
        const requestBody = createCompleteRequest();
        const event = createLambdaEvent('/complete', 'POST', requestBody);

        await handler(event, undefined, deps);

        const deleteCalls = mockS3.commandCalls(DeleteObjectCommand);
        // Should delete both metadata and idempotency metadata
        expect(deleteCalls.length).toBe(2);
        expect(deleteCalls[0].args[0].input.Key).toContain('_metadata.json');
      });

      it('should succeed even if metadata deletion fails', async () => {
        mockS3.on(DeleteObjectCommand).rejects(new Error('Delete failed'));

        const requestBody = createCompleteRequest();
        const event = createLambdaEvent('/complete', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        // Should still succeed - metadata cleanup failure is not critical
        expect(response.statusCode).toBe(200);
      });

      it('should sort parts by PartNumber', async () => {
        const requestBody = createCompleteRequest({
          parts: [
            { PartNumber: 3, ETag: 'etag-3' },
            { PartNumber: 1, ETag: 'etag-1' },
            { PartNumber: 2, ETag: 'etag-2' },
          ],
        });
        const event = createLambdaEvent('/complete', 'POST', requestBody);

        await handler(event, undefined, deps);

        const completeCalls = mockS3.commandCalls(CompleteMultipartUploadCommand);
        const parts = completeCalls[0].args[0].input.MultipartUpload?.Parts;
        expect(parts?.[0].PartNumber).toBe(1);
        expect(parts?.[1].PartNumber).toBe(2);
        expect(parts?.[2].PartNumber).toBe(3);
      });
    });

    describe('Validation Errors', () => {
      it('should return 400 when uploadId is missing', async () => {
        const requestBody = createCompleteRequest({ uploadId: undefined });
        const event = createLambdaEvent('/complete', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(400);
      });

      it('should return 400 when submissionId is invalid UUID', async () => {
        const requestBody = createCompleteRequest({ submissionId: 'not-a-uuid' });
        const event = createLambdaEvent('/complete', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(400);
      });

      it('should return 400 when parts is empty', async () => {
        const requestBody = createCompleteRequest({ parts: [] });
        const event = createLambdaEvent('/complete', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(400);
      });
    });

    describe('AWS Errors', () => {
      it('should return 500 when CompleteMultipartUpload fails', async () => {
        mockS3.on(CompleteMultipartUploadCommand).rejects(new Error('Complete failed'));

        const requestBody = createCompleteRequest();
        const event = createLambdaEvent('/complete', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(500);
      });
    });
  });

  describe('/abort endpoint', () => {
    describe('Success Cases', () => {
      beforeEach(() => {
        mockS3.on(AbortMultipartUploadCommand).resolves({});
        mockS3.on(DeleteObjectCommand).resolves({});
      });

      it('should abort multipart upload', async () => {
        const requestBody = createAbortRequest();
        const event = createLambdaEvent('/abort', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.success).toBe(true);
        expect(body.message).toBe('Upload aborted');
      });

      it('should clean up metadata when submissionId provided', async () => {
        const requestBody = createAbortRequest({
          submissionId: '550e8400-e29b-41d4-a716-446655440000',
        });
        const event = createLambdaEvent('/abort', 'POST', requestBody);

        await handler(event, undefined, deps);

        const deleteCalls = mockS3.commandCalls(DeleteObjectCommand);
        expect(deleteCalls.length).toBe(1);
        expect(deleteCalls[0].args[0].input.Key).toContain('_metadata.json');
      });

      it('should not fail if metadata cleanup fails', async () => {
        mockS3.on(DeleteObjectCommand).rejects(new Error('Delete failed'));

        const requestBody = createAbortRequest({
          submissionId: '550e8400-e29b-41d4-a716-446655440000',
        });
        const event = createLambdaEvent('/abort', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(200);
      });

      it('should skip metadata cleanup when submissionId not provided', async () => {
        const requestBody = createAbortRequest({ submissionId: undefined });
        const event = createLambdaEvent('/abort', 'POST', requestBody);

        await handler(event, undefined, deps);

        const deleteCalls = mockS3.commandCalls(DeleteObjectCommand);
        expect(deleteCalls.length).toBe(0);
      });
    });

    describe('Validation Errors', () => {
      it('should return 400 when uploadId is missing', async () => {
        const requestBody = createAbortRequest({ uploadId: undefined });
        const event = createLambdaEvent('/abort', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(400);
      });

      it('should return 400 when key is missing', async () => {
        const requestBody = createAbortRequest({ key: undefined });
        const event = createLambdaEvent('/abort', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(400);
      });
    });

    describe('AWS Errors', () => {
      it('should return 500 when AbortMultipartUpload fails', async () => {
        mockS3.on(AbortMultipartUploadCommand).rejects(new Error('Abort failed'));

        const requestBody = createAbortRequest();
        const event = createLambdaEvent('/abort', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(500);
      });
    });
  });

  describe('/status endpoint', () => {
    describe('Success Cases', () => {
      it('should return completed parts', async () => {
        mockS3.on(ListPartsCommand).resolves(createMockListPartsResponse(3));

        const requestBody = createStatusRequest();
        const event = createLambdaEvent('/status', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.completedParts).toHaveLength(3);
        expect(body.totalParts).toBe(3);
      });

      it('should handle no completed parts', async () => {
        mockS3.on(ListPartsCommand).resolves(createMockListPartsResponse(0));

        const requestBody = createStatusRequest();
        const event = createLambdaEvent('/status', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.completedParts).toHaveLength(0);
      });

      it('should format part information correctly', async () => {
        mockS3.on(ListPartsCommand).resolves(createMockListPartsResponse(1));

        const requestBody = createStatusRequest();
        const event = createLambdaEvent('/status', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        const body = JSON.parse(response.body);
        expect(body.completedParts[0]).toHaveProperty('partNumber');
        expect(body.completedParts[0]).toHaveProperty('etag');
        expect(body.completedParts[0]).toHaveProperty('size');
      });

      it('should handle pagination for large uploads', async () => {
        // First call returns truncated response
        mockS3.on(ListPartsCommand)
          .resolvesOnce(createMockListPartsResponse(3, true))
          .resolvesOnce(createMockListPartsResponse(2, false));

        const requestBody = createStatusRequest();
        const event = createLambdaEvent('/status', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.completedParts).toHaveLength(5);
      });
    });

    describe('Validation Errors', () => {
      it('should return 400 when uploadId is missing', async () => {
        const requestBody = createStatusRequest({ uploadId: undefined });
        const event = createLambdaEvent('/status', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(400);
      });

      it('should return 400 when key is missing', async () => {
        const requestBody = createStatusRequest({ key: undefined });
        const event = createLambdaEvent('/status', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(400);
      });
    });

    describe('Edge Cases', () => {
      it('should return completed_or_aborted for NoSuchUpload error', async () => {
        // Create an error with the S3-specific name property
        const error = Object.assign(new Error('The specified upload does not exist'), {
          name: 'NoSuchUpload',
        });
        mockS3.on(ListPartsCommand).rejects(error);

        const requestBody = createStatusRequest();
        const event = createLambdaEvent('/status', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.status).toBe('completed_or_aborted');
        expect(body.completedParts).toEqual([]);
      });

      it('should throw other S3 errors', async () => {
        mockS3.on(ListPartsCommand).rejects(new Error('Service unavailable'));

        const requestBody = createStatusRequest();
        const event = createLambdaEvent('/status', 'POST', requestBody);

        const response = await handler(event, undefined, deps);

        expect(response.statusCode).toBe(500);
      });
    });
  });
});

describe('sanitizeFileName', () => {
  it('should remove path traversal attempts', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('../../../file.txt')).toBe('file.txt');
    expect(sanitizeFileName('/etc/passwd')).toBe('passwd');
  });

  it('should remove Windows path components', () => {
    expect(sanitizeFileName('C:\\Users\\test\\file.txt')).toBe('file.txt');
    expect(sanitizeFileName('..\\..\\file.txt')).toBe('file.txt');
  });

  it('should replace dangerous characters', () => {
    expect(sanitizeFileName('file<script>.txt')).toBe('file_script_.txt');
    expect(sanitizeFileName('file|name.pdf')).toBe('file_name.pdf');
    expect(sanitizeFileName('file;rm -rf.sh')).toBe('file_rm -rf.sh');
  });

  it('should handle hidden files', () => {
    const result = sanitizeFileName('.hidden');
    expect(result).toBe('untitled_file');
  });

  it('should handle empty filename', () => {
    const result = sanitizeFileName('');
    expect(result).toBe('untitled_file');
  });

  it('should handle double dots', () => {
    const result = sanitizeFileName('..');
    expect(result).toBe('untitled_file');
  });

  it('should preserve safe filenames', () => {
    expect(sanitizeFileName('document-2024.pdf')).toBe('document-2024.pdf');
    expect(sanitizeFileName('file_name.txt')).toBe('file_name.txt');
    expect(sanitizeFileName('My Document.docx')).toBe('My Document.docx');
  });

  it('should truncate long filenames', () => {
    const longName = 'a'.repeat(300) + '.txt';
    const result = sanitizeFileName(longName);
    expect(result.length).toBeLessThanOrEqual(255);
  });
});
