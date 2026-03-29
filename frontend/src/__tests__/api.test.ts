/**
 * Tests for API client functionality
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// API client implementation (extracted for testing)
const API_BASE = '/api';

interface ApiError {
  error?: string;
  details?: string;
}

async function apiCall<T>(endpoint: string, data: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => ({ error: 'Request failed' }))) as ApiError;
    throw new Error(error.error || error.details || 'API request failed');
  }

  return response.json();
}

describe('apiCall', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });

  it('should make POST request with JSON body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    const result = await apiCall('/initiate', { email: 'test@example.com' });

    expect(mockFetch).toHaveBeenCalledWith('/api/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com' }),
    });
    expect(result).toEqual({ success: true });
  });

  it('should throw error on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'Validation failed' }),
    });

    await expect(apiCall('/initiate', {})).rejects.toThrow('Validation failed');
  });

  it('should handle JSON parse errors gracefully', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => {
        throw new Error('Invalid JSON');
      },
    });

    await expect(apiCall('/initiate', {})).rejects.toThrow('Request failed');
  });

  it('should throw on network errors', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    await expect(apiCall('/initiate', {})).rejects.toThrow('Network error');
  });
});

describe('localStorage resume state', () => {
  const STORAGE_KEY = 'securefiledrop_upload';

  interface UploadState {
    submissionId: string;
    uploadId: string;
    key: string;
    fileName: string;
    fileSize: number;
    chunkSize: number;
  }

  it('should save upload state to localStorage', () => {
    const state: UploadState = {
      submissionId: 'test-id',
      uploadId: 'upload-id',
      key: 'uploads/test-id/file.pdf',
      fileName: 'file.pdf',
      fileSize: 1024,
      chunkSize: 64 * 1024 * 1024,
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

    const saved = localStorage.getItem(STORAGE_KEY);
    expect(saved).toBeTruthy();
    expect(JSON.parse(saved!)).toEqual(state);
  });

  it('should clear upload state on completion', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ test: true }));
    localStorage.removeItem(STORAGE_KEY);

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('should detect pending upload', () => {
    const state: UploadState = {
      submissionId: 'test-id',
      uploadId: 'upload-id',
      key: 'uploads/test-id/file.pdf',
      fileName: 'file.pdf',
      fileSize: 1024,
      chunkSize: 64 * 1024 * 1024,
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as UploadState;
      expect(parsed.uploadId).toBe('upload-id');
      expect(parsed.submissionId).toBe('test-id');
    }
  });
});

describe('upload part handling', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });

  async function uploadPart(
    url: string,
    chunk: Blob,
    partNumber: number,
    signal?: AbortSignal
  ): Promise<string> {
    const response = await fetch(url, {
      method: 'PUT',
      body: chunk,
      signal,
    });

    if (!response.ok) {
      throw new Error(`Failed to upload part ${partNumber}`);
    }

    const etag = response.headers.get('ETag');
    if (!etag) {
      throw new Error(`No ETag received for part ${partNumber}`);
    }

    return etag;
  }

  it('should upload a part and return ETag', async () => {
    const mockHeaders = new Headers();
    mockHeaders.set('ETag', '"abc123"');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: mockHeaders,
    });

    const chunk = new Blob(['test data']);
    const etag = await uploadPart('https://s3.amazonaws.com/presigned', chunk, 1);

    expect(etag).toBe('"abc123"');
    expect(mockFetch).toHaveBeenCalledWith('https://s3.amazonaws.com/presigned', {
      method: 'PUT',
      body: chunk,
      signal: undefined,
    });
  });

  it('should throw error on failed upload', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
    });

    const chunk = new Blob(['test data']);
    await expect(uploadPart('https://s3.amazonaws.com/presigned', chunk, 1)).rejects.toThrow(
      'Failed to upload part 1'
    );
  });

  it('should throw error when no ETag received', async () => {
    const mockHeaders = new Headers();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: mockHeaders,
    });

    const chunk = new Blob(['test data']);
    await expect(uploadPart('https://s3.amazonaws.com/presigned', chunk, 1)).rejects.toThrow(
      'No ETag received for part 1'
    );
  });
});

describe('chunk calculation', () => {
  const DEFAULT_CHUNK_SIZE = 64 * 1024 * 1024; // 64MB
  const MAX_S3_PART_NUMBER = 10000;

  // Dynamic chunk sizing: scales chunk size for files > 640GB to stay within S3's 10,000 part limit
  function calculateChunkSize(fileSize: number): number {
    const OPTIMAL_CHUNK_SIZE_THRESHOLD = 640 * 1024 * 1024 * 1024; // 640GB
    const MIN_CHUNK_SIZE = 5 * 1024 * 1024; // 5MB
    const MAX_CHUNK_SIZE = 525 * 1024 * 1024; // 525MB

    if (fileSize <= OPTIMAL_CHUNK_SIZE_THRESHOLD) {
      return DEFAULT_CHUNK_SIZE;
    }

    const minRequired = Math.ceil(fileSize / MAX_S3_PART_NUMBER);
    const roundedToMB = Math.ceil(minRequired / (1024 * 1024)) * (1024 * 1024);
    return Math.max(MIN_CHUNK_SIZE, Math.min(roundedToMB, MAX_CHUNK_SIZE));
  }

  function calculateTotalParts(fileSize: number): number {
    const chunkSize = calculateChunkSize(fileSize);
    return Math.ceil(fileSize / chunkSize);
  }

  it('should calculate parts for small file', () => {
    expect(calculateTotalParts(1024)).toBe(1); // 1KB
  });

  it('should calculate parts for exactly one chunk', () => {
    expect(calculateTotalParts(DEFAULT_CHUNK_SIZE)).toBe(1);
  });

  it('should calculate parts for file slightly larger than one chunk', () => {
    expect(calculateTotalParts(DEFAULT_CHUNK_SIZE + 1)).toBe(2);
  });

  it('should calculate parts for 1GB file', () => {
    const oneGB = 1024 * 1024 * 1024;
    expect(calculateTotalParts(oneGB)).toBe(16); // 1GB / 64MB = 16
  });

  it('should calculate parts for 5TB file', () => {
    const fiveTB = 5 * 1024 * 1024 * 1024 * 1024;
    // With dynamic chunk sizing, 5TB files use larger chunks to stay within 10,000 parts
    expect(calculateTotalParts(fiveTB)).toBeLessThanOrEqual(MAX_S3_PART_NUMBER);
  });
});

describe('file validation', () => {
  const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024 * 1024; // 5TB

  function validateFile(file: { size: number; name: string }): string | null {
    if (file.size <= 0) {
      return 'File is empty';
    }
    if (file.size > MAX_FILE_SIZE) {
      return 'File exceeds maximum size of 5TB';
    }
    if (!file.name || file.name.trim() === '') {
      return 'File name is required';
    }
    return null;
  }

  it('should pass valid file', () => {
    expect(validateFile({ size: 1024, name: 'test.pdf' })).toBeNull();
  });

  it('should reject empty file', () => {
    expect(validateFile({ size: 0, name: 'test.pdf' })).toBe('File is empty');
  });

  it('should reject file exceeding max size', () => {
    expect(validateFile({ size: MAX_FILE_SIZE + 1, name: 'test.pdf' })).toBe(
      'File exceeds maximum size of 5TB'
    );
  });

  it('should reject file with no name', () => {
    expect(validateFile({ size: 1024, name: '' })).toBe('File name is required');
  });
});

describe('email validation', () => {
  function validateEmail(email: string): boolean {
    return email.includes('@') && email.includes('.');
  }

  it('should accept valid email', () => {
    expect(validateEmail('test@example.com')).toBe(true);
  });

  it('should reject email without @', () => {
    expect(validateEmail('testexample.com')).toBe(false);
  });

  it('should reject email without dot', () => {
    expect(validateEmail('test@examplecom')).toBe(false);
  });
});
