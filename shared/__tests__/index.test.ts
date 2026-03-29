/**
 * Tests for shared utilities
 */

import {
  formatBytes,
  calculateChunkSize,
  sanitizeContentType,
  isDangerousContentType,
  generateIdempotencyKey,
  getIdempotencyMetadataKey,
  isUploadStillActive,
  isAbortError,
  isRetryableError,
  DEFAULT_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  MAX_S3_PART_NUMBER,
  OPTIMAL_CHUNK_SIZE_THRESHOLD,
  SAFE_FALLBACK_CONTENT_TYPE,
  IDEMPOTENCY_TTL_HOURS,
  RETENTION_DAYS,
} from '../index';

// ============================================================================
// formatBytes tests
// ============================================================================

describe('formatBytes', () => {
  it('should format 0 bytes', () => {
    expect(formatBytes(0)).toBe('0 Bytes');
  });

  it('should format bytes', () => {
    expect(formatBytes(500)).toBe('500 Bytes');
  });

  it('should format kilobytes', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('should format megabytes', () => {
    expect(formatBytes(1048576)).toBe('1 MB');
  });

  it('should format gigabytes', () => {
    expect(formatBytes(1073741824)).toBe('1 GB');
  });

  it('should format terabytes', () => {
    expect(formatBytes(1099511627776)).toBe('1 TB');
  });
});

// ============================================================================
// calculateChunkSize tests
// ============================================================================

describe('calculateChunkSize', () => {
  describe('small files (≤ 640GB)', () => {
    it('should return DEFAULT_CHUNK_SIZE for 1GB file', () => {
      const fileSize = 1 * 1024 * 1024 * 1024;
      expect(calculateChunkSize(fileSize)).toBe(DEFAULT_CHUNK_SIZE);
    });

    it('should return DEFAULT_CHUNK_SIZE for 100GB file', () => {
      const fileSize = 100 * 1024 * 1024 * 1024;
      expect(calculateChunkSize(fileSize)).toBe(DEFAULT_CHUNK_SIZE);
    });

    it('should return DEFAULT_CHUNK_SIZE for exactly 640GB', () => {
      expect(calculateChunkSize(OPTIMAL_CHUNK_SIZE_THRESHOLD)).toBe(DEFAULT_CHUNK_SIZE);
    });
  });

  describe('large files (> 640GB)', () => {
    it('should scale chunk size for 641GB file', () => {
      const fileSize = 641 * 1024 * 1024 * 1024;
      const chunkSize = calculateChunkSize(fileSize);

      expect(chunkSize).toBeGreaterThan(DEFAULT_CHUNK_SIZE);

      const parts = Math.ceil(fileSize / chunkSize);
      expect(parts).toBeLessThanOrEqual(MAX_S3_PART_NUMBER);
    });

    it('should calculate correct chunk size for 1TB file', () => {
      const fileSize = 1024 * 1024 * 1024 * 1024;
      const chunkSize = calculateChunkSize(fileSize);

      expect(chunkSize).toBeGreaterThanOrEqual(109 * 1024 * 1024);

      const parts = Math.ceil(fileSize / chunkSize);
      expect(parts).toBeLessThanOrEqual(MAX_S3_PART_NUMBER);
    });

    it('should handle 5TB maximum', () => {
      const fileSize = 5 * 1024 * 1024 * 1024 * 1024;
      const chunkSize = calculateChunkSize(fileSize);

      expect(chunkSize).toBeLessThanOrEqual(MAX_CHUNK_SIZE);
      expect(chunkSize).toBeGreaterThanOrEqual(MIN_CHUNK_SIZE);

      const parts = Math.ceil(fileSize / chunkSize);
      expect(parts).toBeLessThanOrEqual(MAX_S3_PART_NUMBER);
    });
  });

  describe('edge cases', () => {
    it('should round up to MB boundaries', () => {
      const fileSize = 700 * 1024 * 1024 * 1024;
      const chunkSize = calculateChunkSize(fileSize);

      expect(chunkSize % (1024 * 1024)).toBe(0);
    });

    it('should never return chunk size below MIN_CHUNK_SIZE', () => {
      const fileSize = 10 * 1024 * 1024;
      const chunkSize = calculateChunkSize(fileSize);

      expect(chunkSize).toBeGreaterThanOrEqual(MIN_CHUNK_SIZE);
    });

    it('should never return chunk size above MAX_CHUNK_SIZE', () => {
      const fileSize = 5 * 1024 * 1024 * 1024 * 1024;
      const chunkSize = calculateChunkSize(fileSize);

      expect(chunkSize).toBeLessThanOrEqual(MAX_CHUNK_SIZE);
    });
  });

  describe('part count validation', () => {
    const testSizes = [
      100 * 1024 * 1024 * 1024,      // 100GB
      640 * 1024 * 1024 * 1024,      // 640GB
      1024 * 1024 * 1024 * 1024,     // 1TB
      2 * 1024 * 1024 * 1024 * 1024, // 2TB
      5 * 1024 * 1024 * 1024 * 1024, // 5TB
    ];

    testSizes.forEach(fileSize => {
      it(`should produce valid part count for ${formatBytes(fileSize)} file`, () => {
        const chunkSize = calculateChunkSize(fileSize);
        const parts = Math.ceil(fileSize / chunkSize);

        expect(parts).toBeGreaterThan(0);
        expect(parts).toBeLessThanOrEqual(MAX_S3_PART_NUMBER);
      });
    });
  });
});

// ============================================================================
// Content-Type Validation tests
// ============================================================================

describe('isDangerousContentType', () => {
  it('should identify HTML as dangerous', () => {
    expect(isDangerousContentType('text/html')).toBe(true);
  });

  it('should identify JavaScript as dangerous', () => {
    expect(isDangerousContentType('application/javascript')).toBe(true);
    expect(isDangerousContentType('text/javascript')).toBe(true);
  });

  it('should identify SVG as dangerous', () => {
    expect(isDangerousContentType('image/svg+xml')).toBe(true);
  });

  it('should identify safe types', () => {
    expect(isDangerousContentType('image/jpeg')).toBe(false);
    expect(isDangerousContentType('application/pdf')).toBe(false);
    expect(isDangerousContentType('video/mp4')).toBe(false);
  });

  it('should handle case insensitivity', () => {
    expect(isDangerousContentType('TEXT/HTML')).toBe(true);
    expect(isDangerousContentType('Application/JavaScript')).toBe(true);
  });

  it('should handle content-type with parameters', () => {
    expect(isDangerousContentType('text/html; charset=utf-8')).toBe(true);
  });
});

describe('sanitizeContentType', () => {
  it('should block text/html', () => {
    expect(sanitizeContentType('text/html')).toBe(SAFE_FALLBACK_CONTENT_TYPE);
  });

  it('should block application/javascript', () => {
    expect(sanitizeContentType('application/javascript')).toBe(SAFE_FALLBACK_CONTENT_TYPE);
  });

  it('should allow image/jpeg', () => {
    expect(sanitizeContentType('image/jpeg')).toBe('image/jpeg');
  });

  it('should allow application/pdf', () => {
    expect(sanitizeContentType('application/pdf')).toBe('application/pdf');
  });

  it('should handle undefined', () => {
    expect(sanitizeContentType(undefined)).toBe(SAFE_FALLBACK_CONTENT_TYPE);
  });

  it('should handle empty string', () => {
    expect(sanitizeContentType('')).toBe(SAFE_FALLBACK_CONTENT_TYPE);
  });

  it('should normalize case', () => {
    expect(sanitizeContentType('IMAGE/JPEG')).toBe('image/jpeg');
  });

  it('should strip parameters but preserve type', () => {
    expect(sanitizeContentType('image/jpeg; quality=80')).toBe('image/jpeg');
  });

  it('should handle whitespace', () => {
    expect(sanitizeContentType('  image/png  ')).toBe('image/png');
  });
});

// ============================================================================
// Idempotency tests
// ============================================================================

describe('generateIdempotencyKey', () => {
  it('should be deterministic', () => {
    const key1 = generateIdempotencyKey('test@example.com', 'file.pdf', 1024);
    const key2 = generateIdempotencyKey('test@example.com', 'file.pdf', 1024);
    expect(key1).toBe(key2);
  });

  it('should differ for different inputs', () => {
    const key1 = generateIdempotencyKey('test@example.com', 'file1.pdf', 1024);
    const key2 = generateIdempotencyKey('test@example.com', 'file2.pdf', 1024);
    expect(key1).not.toBe(key2);
  });

  it('should differ for different file sizes', () => {
    const key1 = generateIdempotencyKey('test@example.com', 'file.pdf', 1024);
    const key2 = generateIdempotencyKey('test@example.com', 'file.pdf', 2048);
    expect(key1).not.toBe(key2);
  });

  it('should handle special characters in email', () => {
    const key = generateIdempotencyKey('test+special@example.com', 'file.pdf', 1024);
    expect(key).toBeDefined();
    expect(key.length).toBeGreaterThan(0);
  });
});

describe('getIdempotencyMetadataKey', () => {
  it('should generate correct S3 key', () => {
    const idempotencyKey = 'test_key_123';
    const result = getIdempotencyMetadataKey(idempotencyKey);
    expect(result).toBe('uploads/_idempotency/test_key_123_metadata.json');
  });
});

describe('isUploadStillActive', () => {
  it('should return true for recent uploads', () => {
    const now = new Date().toISOString();
    expect(isUploadStillActive(now)).toBe(true);
  });

  it('should return true for uploads within TTL', () => {
    const withinTTL = new Date(Date.now() - (RETENTION_DAYS - 1) * 24 * 60 * 60 * 1000).toISOString();
    expect(isUploadStillActive(withinTTL)).toBe(true);
  });

  it('should return false for uploads older than TTL', () => {
    const beyondTTL = new Date(Date.now() - (RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
    expect(isUploadStillActive(beyondTTL)).toBe(false);
  });

  it('should handle exact boundary', () => {
    const exactTTL = new Date(Date.now() - IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000 + 1000).toISOString();
    expect(isUploadStillActive(exactTTL)).toBe(true);
  });
});

// ============================================================================
// Retry utility tests
// ============================================================================

describe('isAbortError', () => {
  it('should return true for AbortError', () => {
    const error = new Error('Operation aborted');
    error.name = 'AbortError';
    expect(isAbortError(error)).toBe(true);
  });

  it('should return true for abort message', () => {
    const error = new Error('The operation was aborted');
    expect(isAbortError(error)).toBe(true);
  });

  it('should return true for cancel message', () => {
    const error = new Error('Request cancelled by user');
    expect(isAbortError(error)).toBe(true);
  });

  it('should return false for regular errors', () => {
    const error = new Error('Network failure');
    expect(isAbortError(error)).toBe(false);
  });

  it('should return false for null/undefined', () => {
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});

describe('isRetryableError', () => {
  it('should return false for abort errors', () => {
    const error = new Error('Operation aborted');
    error.name = 'AbortError';
    expect(isRetryableError(error)).toBe(false);
  });

  it('should return true for TypeError (network error)', () => {
    const error = new TypeError('Failed to fetch');
    expect(isRetryableError(error)).toBe(true);
  });

  it('should return true for timeout errors', () => {
    const error = new Error('Request timeout');
    expect(isRetryableError(error)).toBe(true);
  });

  it('should return true for network errors', () => {
    const error = new Error('Network failure');
    expect(isRetryableError(error)).toBe(true);
  });

  it('should return false for generic errors', () => {
    const error = new Error('Validation failed');
    expect(isRetryableError(error)).toBe(false);
  });
});
