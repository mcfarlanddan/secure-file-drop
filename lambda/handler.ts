import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { randomUUID } from 'crypto';

const s3 = new S3Client({});
const sns = new SNSClient({});

const BUCKET_NAME = process.env.BUCKET_NAME!;
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN!;
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || '67108864', 10); // 64MB

interface LambdaEvent {
  rawPath: string;
  body?: string;
  requestContext: {
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

function response(statusCode: number, body: unknown): ApiResponse {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export async function handler(event: LambdaEvent): Promise<ApiResponse> {
  // Strip /api prefix from CloudFront routing
  const path = event.rawPath.replace('/api', '');
  const method = event.requestContext.http.method;

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }

  try {
    const body = event.body ? JSON.parse(event.body) : {};

    switch (path) {
      case '/initiate':
        return await initiateUpload(body);
      case '/presign':
        return await presignParts(body);
      case '/complete':
        return await completeUpload(body);
      case '/abort':
        return await abortUpload(body);
      case '/status':
        return await getStatus(body);
      default:
        return response(404, { error: 'Not found', path });
    }
  } catch (error) {
    console.error('Handler error:', error);
    return response(500, { error: 'Internal server error', message: String(error) });
  }
}

interface InitiateRequest {
  email: string;
  title?: string;
  description?: string;
  fileName: string;
  fileSize: number;
  contentType: string;
}

async function initiateUpload(body: InitiateRequest): Promise<ApiResponse> {
  const { email, title, description, fileName, fileSize, contentType } = body;

  if (!email || !fileName || !fileSize) {
    return response(400, { error: 'Missing required fields: email, fileName, fileSize' });
  }

  const submissionId = randomUUID();
  const key = `uploads/${submissionId}/${fileName}`;

  // Create multipart upload
  const createCommand = new CreateMultipartUploadCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    ContentType: contentType || 'application/octet-stream',
  });

  const { UploadId } = await s3.send(createCommand);

  // Store metadata as JSON file
  const metadata = {
    email,
    title: title || fileName,
    description: description || '',
    fileName,
    fileSize,
    contentType,
    submissionId,
    uploadId: UploadId,
    key,
    createdAt: new Date().toISOString(),
  };

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: `uploads/${submissionId}/_metadata.json`,
    Body: JSON.stringify(metadata, null, 2),
    ContentType: 'application/json',
  }));

  // Send "Started" notification
  await sns.send(new PublishCommand({
    TopicArn: SNS_TOPIC_ARN,
    Subject: `[Secure File Drop] Upload started: ${title || fileName}`,
    Message: [
      `New upload started`,
      ``,
      `From: ${email}`,
      `File: ${fileName}`,
      `Size: ${formatBytes(fileSize)}`,
      `Submission ID: ${submissionId}`,
      ``,
      `You'll receive another notification when the upload completes.`,
    ].join('\n'),
  }));

  const totalParts = Math.ceil(fileSize / CHUNK_SIZE);

  return response(200, {
    submissionId,
    uploadId: UploadId,
    key,
    totalParts,
    chunkSize: CHUNK_SIZE,
  });
}

interface PresignRequest {
  uploadId: string;
  key: string;
  partNumbers: number[];
}

async function presignParts(body: PresignRequest): Promise<ApiResponse> {
  const { uploadId, key, partNumbers } = body;

  if (!uploadId || !key || !partNumbers || !Array.isArray(partNumbers)) {
    return response(400, { error: 'Missing required fields: uploadId, key, partNumbers' });
  }

  const urls = await Promise.all(
    partNumbers.map(async (partNumber: number) => {
      const command = new UploadPartCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      });

      const url = await getSignedUrl(s3, command, { expiresIn: 3600 });
      return { partNumber, url };
    })
  );

  return response(200, { urls });
}

interface CompleteRequest {
  uploadId: string;
  key: string;
  parts: Array<{ PartNumber: number; ETag: string }>;
  submissionId: string;
}

async function completeUpload(body: CompleteRequest): Promise<ApiResponse> {
  const { uploadId, key, parts, submissionId } = body;

  if (!uploadId || !key || !parts || !submissionId) {
    return response(400, { error: 'Missing required fields: uploadId, key, parts, submissionId' });
  }

  // Complete multipart upload
  await s3.send(new CompleteMultipartUploadCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: {
      Parts: parts.sort((a, b) => a.PartNumber - b.PartNumber),
    },
  }));

  // Get metadata for notification
  let meta: Record<string, unknown> = { fileName: key, email: 'unknown' };
  try {
    const metadataObj = await s3.send(new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: `uploads/${submissionId}/_metadata.json`,
    }));
    meta = JSON.parse(await metadataObj.Body!.transformToString());
  } catch (e) {
    console.warn('Could not read metadata:', e);
  }

  // Send "Complete" notification
  await sns.send(new PublishCommand({
    TopicArn: SNS_TOPIC_ARN,
    Subject: `[Secure File Drop] Upload complete: ${meta.title || meta.fileName}`,
    Message: [
      `Upload completed successfully!`,
      ``,
      `From: ${meta.email}`,
      `File: ${meta.fileName}`,
      `Size: ${formatBytes(meta.fileSize as number)}`,
      `Title: ${meta.title || 'N/A'}`,
      `Description: ${meta.description || 'N/A'}`,
      ``,
      `Location: s3://${BUCKET_NAME}/${key}`,
      `Submission ID: ${submissionId}`,
    ].join('\n'),
  }));

  return response(200, { success: true, message: 'Upload completed successfully' });
}

interface AbortRequest {
  uploadId: string;
  key: string;
}

async function abortUpload(body: AbortRequest): Promise<ApiResponse> {
  const { uploadId, key } = body;

  if (!uploadId || !key) {
    return response(400, { error: 'Missing required fields: uploadId, key' });
  }

  await s3.send(new AbortMultipartUploadCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    UploadId: uploadId,
  }));

  return response(200, { success: true, message: 'Upload aborted' });
}

interface StatusRequest {
  uploadId: string;
  key: string;
}

async function getStatus(body: StatusRequest): Promise<ApiResponse> {
  const { uploadId, key } = body;

  if (!uploadId || !key) {
    return response(400, { error: 'Missing required fields: uploadId, key' });
  }

  try {
    // Use S3 ListParts to check upload progress - no DynamoDB needed!
    const { Parts } = await s3.send(new ListPartsCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      UploadId: uploadId,
    }));

    return response(200, {
      completedParts: (Parts || []).map(p => ({
        partNumber: p.PartNumber,
        etag: p.ETag,
        size: p.Size,
      })),
    });
  } catch (error: unknown) {
    // Upload might have been completed or aborted
    const err = error as { name?: string };
    if (err.name === 'NoSuchUpload') {
      return response(200, { completedParts: [], status: 'completed_or_aborted' });
    }
    throw error;
  }
}
