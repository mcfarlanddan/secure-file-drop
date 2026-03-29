/**
 * Secure File Drop - Main Entry Point
 *
 * This module initializes the upload application and wires together
 * the components for form handling, progress tracking, and resume functionality.
 */

import pLimit from 'p-limit';
import { z } from 'zod';
import {
  formatBytes,
  InitiateResponse,
  PresignResponse,
  StatusResponse,
  CompleteResponse,
  AbortResponse,
  DEFAULT_CHUNK_SIZE,
} from '@shared/index';
import { withRetry } from './retry';

// ============================================================================
// CONFIGURATION
// ============================================================================

const API_BASE = '/api';
const CONCURRENT_UPLOADS = 5;
const PRESIGN_BATCH_SIZE = 10;
const VALIDATION_MESSAGE_TIMEOUT_MS = 5000;

/**
 * Email validation regex.
 * Matches: standard email format with reasonable constraints.
 * - Local part: alphanumeric plus . _ % + -
 * - Domain: alphanumeric plus . -
 * - TLD: at least 2 letters
 * Backend performs authoritative validation with Zod.
 */
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

// ============================================================================
// DOM UTILITIES
// ============================================================================

/**
 * Safely retrieves a DOM element by ID with type checking.
 * Throws a descriptive error if the element is missing or wrong type.
 */
function getElement<T extends HTMLElement>(
  id: string,
  expectedType: new () => T
): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Required element #${id} not found in DOM`);
  }
  if (!(element instanceof expectedType)) {
    throw new Error(`Element #${id} is not a ${expectedType.name}`);
  }
  return element;
}

/**
 * Safely retrieves a DOM element by selector with type checking.
 */
function querySelector<T extends HTMLElement>(
  selector: string,
  expectedType: new () => T
): T {
  const element = document.querySelector(selector);
  if (!element) {
    throw new Error(`Required element "${selector}" not found in DOM`);
  }
  if (!(element instanceof expectedType)) {
    throw new Error(`Element "${selector}" is not a ${expectedType.name}`);
  }
  return element;
}

// ============================================================================
// TYPES
// ============================================================================

/**
 * Schema for validating saved upload state from localStorage.
 * Ensures corrupted or incompatible saved state doesn't cause runtime errors.
 */
const UploadStateSchema = z.object({
  submissionId: z.string().min(1),
  uploadId: z.string().min(1),
  key: z.string().min(1),
  fileName: z.string().min(1),
  fileSize: z.number().positive(),
  chunkSize: z.number().positive(),
});

type UploadState = z.infer<typeof UploadStateSchema>;

interface CompletedPart {
  PartNumber: number;
  ETag: string;
}

interface ResumeState extends UploadState {
  completedParts: Array<{ partNumber: number; etag: string; size: number }>;
}

// ============================================================================
// DOM ELEMENTS
// ============================================================================

const form = getElement('upload-form', HTMLFormElement);
const fileInput = getElement('file', HTMLInputElement);
const fileInfo = getElement('file-info', HTMLDivElement);
const submitBtn = getElement('submit-btn', HTMLButtonElement);
const progressSection = getElement('progress-section', HTMLDivElement);
const progressFilename = getElement('progress-filename', HTMLSpanElement);
const progressPercent = getElement('progress-percent', HTMLSpanElement);
const progressFill = getElement('progress-fill', HTMLDivElement);
const progressUploaded = getElement('progress-uploaded', HTMLSpanElement);
const progressTotal = getElement('progress-total', HTMLSpanElement);
const progressSpeed = getElement('progress-speed', HTMLSpanElement);
const cancelBtn = getElement('cancel-btn', HTMLButtonElement);
const statusMessage = getElement('status-message', HTMLDivElement);
const successSection = getElement('success-section', HTMLDivElement);
const successFilename = getElement('success-filename', HTMLParagraphElement);
const successNote = getElement('success-note', HTMLParagraphElement);
const anotherBtn = getElement('another-btn', HTMLButtonElement);
const resumeBanner = getElement('resume-banner', HTMLDivElement);
const resumeFilename = getElement('resume-filename', HTMLSpanElement);
const resumeBtn = getElement('resume-btn', HTMLButtonElement);
const freshBtn = getElement('fresh-btn', HTMLButtonElement);
const resumeError = getElement('resume-error', HTMLDivElement);
const validationMessage = getElement('validation-message', HTMLDivElement);
const ariaLive = getElement('aria-live', HTMLDivElement);
const emailInput = getElement('email', HTMLInputElement);
const titleInput = getElement('title', HTMLInputElement);
const descriptionInput = getElement('description', HTMLTextAreaElement);

// ============================================================================
// STATE
// ============================================================================

let currentUpload: UploadState | null = null;
let abortController: AbortController | null = null;
let savedUpload: UploadState | null = null;

const STORAGE_KEY = 'securefiledrop_upload';

// ============================================================================
// API CLIENT
// ============================================================================

async function apiCall<T>(
  endpoint: string,
  data: unknown,
  signal?: AbortSignal
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || error.details || 'API request failed');
  }

  // Handle potential malformed JSON in successful responses
  const text = await response.text();
  if (!text) {
    throw new Error('Empty response from server');
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('Invalid JSON response from server');
  }
}

/**
 * API call with retry logic for critical operations.
 * Does not accept AbortSignal - retries until success or max attempts.
 */
async function apiCallWithRetry<T>(
  endpoint: string,
  data: unknown
): Promise<T> {
  const wrappedCall = withRetry(
    () => apiCall<T>(endpoint, data),
    {
      onRetry: (attempt, delay, error) => {
        const seconds = Math.round(delay / 1000);
        console.warn(`API retry for ${endpoint} (attempt ${attempt + 2}/3): ${error.message}, waiting ${seconds}s`);
        announceProgress(`Retrying... please wait`);
      },
    }
  );
  return wrappedCall();
}

// ============================================================================
// VALIDATION UI
// ============================================================================

function showValidationError(message: string): void {
  validationMessage.textContent = message;
  validationMessage.classList.remove('hidden');
  validationMessage.classList.add('error');

  // Announce to screen readers
  ariaLive.textContent = message;

  // Focus the message for keyboard users
  validationMessage.focus();

  // Auto-hide after timeout
  setTimeout(() => {
    hideValidationMessage();
  }, VALIDATION_MESSAGE_TIMEOUT_MS);
}

function hideValidationMessage(): void {
  validationMessage.classList.add('hidden');
  validationMessage.textContent = '';
}

function announceProgress(message: string): void {
  ariaLive.textContent = message;
}

// ============================================================================
// FILE INPUT HANDLING
// ============================================================================

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) {
    fileInfo.textContent = `${file.name} (${formatBytes(file.size)})`;
  } else {
    fileInfo.textContent = 'No file selected';
  }
  hideValidationMessage();
});

// Drag and drop visual feedback
const fileInputWrapper = querySelector('.file-input-wrapper', HTMLDivElement);

fileInputWrapper.addEventListener('dragover', (e) => {
  e.preventDefault();
  fileInputWrapper.classList.add('drag-over');
});

fileInputWrapper.addEventListener('dragleave', (e) => {
  e.preventDefault();
  fileInputWrapper.classList.remove('drag-over');
});

fileInputWrapper.addEventListener('drop', () => {
  fileInputWrapper.classList.remove('drag-over');
});

// ============================================================================
// UPLOAD LOGIC
// ============================================================================

/**
 * Uploads a single part to S3 using a presigned URL.
 * This is the raw implementation without retry logic.
 */
async function uploadPartRaw(
  url: string,
  chunk: Blob,
  partNumber: number,
  signal: AbortSignal
): Promise<string> {
  const response = await fetch(url, {
    method: 'PUT',
    body: chunk,
    signal,
  });

  if (!response.ok) {
    // Attach status for retry logic classification
    const error = new Error(`Failed to upload part ${partNumber}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  const etag = response.headers.get('ETag');
  if (!etag) {
    throw new Error(`No ETag received for part ${partNumber}`);
  }

  return etag;
}

/**
 * Upload part with automatic retry logic.
 * Retries on 5xx errors and network failures with exponential backoff.
 */
function createUploadPartWithRetry(signal: AbortSignal) {
  return withRetry(uploadPartRaw, {
    signal,
    onRetry: (attempt, delay, error) => {
      const seconds = Math.round(delay / 1000);
      const message = `Retrying upload (attempt ${attempt + 2}/3)... waiting ${seconds}s`;
      announceProgress(message);
      console.warn(`Retry: ${error.message}`, { attempt: attempt + 1, delay });
    },
  });
}

async function startUpload(
  file: File,
  email: string,
  title: string,
  description: string,
  resumeState: ResumeState | null = null
): Promise<void> {
  abortController = new AbortController();
  const signal = abortController.signal;

  // Create retry-wrapped upload function for this session
  const uploadPartWithRetry = createUploadPartWithRetry(signal);

  let chunkSize: number;
  let totalParts: number;

  const completedParts: CompletedPart[] = [];
  let uploadedBytes = 0;

  // Track bytes uploaded during THIS session (for accurate speed calculation)
  let sessionStartBytes = 0;
  const sessionStartTime = Date.now();

  // Update UI
  form.classList.add('hidden');
  progressSection.classList.remove('hidden');
  statusMessage.classList.add('hidden');
  progressFilename.textContent = file.name;
  progressTotal.textContent = formatBytes(file.size);

  // Move focus to progress section for accessibility
  progressSection.focus();
  announceProgress(`Starting upload of ${file.name}`);

  try {
    if (resumeState) {
      // Resume existing upload
      currentUpload = {
        submissionId: resumeState.submissionId,
        uploadId: resumeState.uploadId,
        key: resumeState.key,
        fileName: resumeState.fileName,
        fileSize: resumeState.fileSize,
        chunkSize: resumeState.chunkSize,
      };

      chunkSize = resumeState.chunkSize || DEFAULT_CHUNK_SIZE;
      totalParts = Math.ceil(file.size / chunkSize);

      // Add already completed parts
      for (const p of resumeState.completedParts) {
        completedParts.push({ PartNumber: p.partNumber, ETag: p.etag });
        uploadedBytes += p.size;
      }

      sessionStartBytes = uploadedBytes;

      // Update progress to show already uploaded
      const percent = Math.round((uploadedBytes / file.size) * 100);
      progressPercent.textContent = `${percent}%`;
      progressFill.style.width = `${percent}%`;
      progressUploaded.textContent = formatBytes(uploadedBytes);

      announceProgress(`Resuming upload: ${percent}% already complete`);
    } else {
      // Initiate new upload
      const initResponse = await apiCall<InitiateResponse>('/initiate', {
        email,
        title,
        description,
        fileName: file.name,
        fileSize: file.size,
        contentType: file.type || 'application/octet-stream',
      }, signal);

      currentUpload = {
        submissionId: initResponse.submissionId,
        uploadId: initResponse.uploadId,
        key: initResponse.key,
        fileName: file.name,
        fileSize: file.size,
        chunkSize: initResponse.chunkSize,
      };

      chunkSize = initResponse.chunkSize || DEFAULT_CHUNK_SIZE;
      totalParts = initResponse.totalParts;

      // Save to localStorage for potential resume
      localStorage.setItem(STORAGE_KEY, JSON.stringify(currentUpload));
    }

    // Build queue of parts to upload
    const completedPartNumbers = new Set(completedParts.map((p) => p.PartNumber));
    const partQueue: number[] = [];
    for (let i = 1; i <= totalParts; i++) {
      if (!completedPartNumbers.has(i)) {
        partQueue.push(i);
      }
    }

    // Create concurrency limiter
    const limit = pLimit(CONCURRENT_UPLOADS);

    // Process parts in batches
    while (partQueue.length > 0) {
      if (signal.aborted) throw new Error('Upload cancelled');

      // Get presigned URLs for next batch
      const batchPartNumbers = partQueue.splice(0, PRESIGN_BATCH_SIZE);
      const presignResponse = await apiCall<PresignResponse>('/presign', {
        uploadId: currentUpload.uploadId,
        key: currentUpload.key,
        partNumbers: batchPartNumbers,
      }, signal);

      const urlMap = new Map(presignResponse.urls.map((u) => [u.partNumber, u.url]));

      // Upload parts concurrently
      const uploadPromises = batchPartNumbers.map((partNumber) => {
        const start = (partNumber - 1) * chunkSize;
        const end = Math.min(start + chunkSize, file.size);
        const chunk = file.slice(start, end);
        const url = urlMap.get(partNumber)!;

        return limit(() =>
          uploadPartWithRetry(url, chunk, partNumber, signal).then((etag) => {
            completedParts.push({ PartNumber: partNumber, ETag: etag });
            uploadedBytes += chunk.size;

            // Update progress
            const percent = Math.round((uploadedBytes / file.size) * 100);
            progressPercent.textContent = `${percent}%`;
            progressFill.style.width = `${percent}%`;
            progressUploaded.textContent = formatBytes(uploadedBytes);

            // Calculate speed based on session bytes only
            const sessionBytes = uploadedBytes - sessionStartBytes;
            const elapsed = (Date.now() - sessionStartTime) / 1000;
            if (elapsed > 0 && sessionBytes > 0) {
              const speed = sessionBytes / elapsed;
              progressSpeed.textContent = `${formatBytes(speed)}/s`;
            }

            // Periodic announcements for screen readers (every 25%)
            if (percent % 25 === 0) {
              announceProgress(`Upload ${percent}% complete`);
            }
          })
        );
      });

      await Promise.all(uploadPromises);
    }

    // Complete the upload with retry (critical operation - must succeed after parts uploaded)
    // No AbortSignal - we want completion to finish even if user tries to cancel
    const completeResult = await apiCallWithRetry<CompleteResponse>('/complete', {
      uploadId: currentUpload.uploadId,
      key: currentUpload.key,
      parts: completedParts,
      submissionId: currentUpload.submissionId,
    });

    // Clear saved state
    localStorage.removeItem(STORAGE_KEY);
    const uploadedFileName = file.name;
    currentUpload = null;

    // Show success
    progressSection.classList.add('hidden');
    successFilename.textContent = uploadedFileName;

    // Update success note based on notification status
    if (completeResult.notificationSent === false) {
      successNote.textContent = 'Upload complete. Note: Email notification could not be sent. Please contact support if you need confirmation.';
      successNote.classList.add('warning');
    } else {
      successNote.textContent = 'You will receive an email confirmation shortly.';
      successNote.classList.remove('warning');
    }

    successSection.classList.remove('hidden');

    // Focus success section for accessibility
    successSection.focus();
    announceProgress(`Upload of ${uploadedFileName} completed successfully`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (errorMessage === 'Upload cancelled') {
      // Abort on server
      if (currentUpload) {
        try {
          await apiCall<AbortResponse>('/abort', {
            uploadId: currentUpload.uploadId,
            key: currentUpload.key,
            submissionId: currentUpload.submissionId,
          });
        } catch (e) {
          console.warn('Failed to abort upload on server:', e);
        }
      }
      localStorage.removeItem(STORAGE_KEY);
      showStatusMessage('Upload cancelled.', 'error');
      announceProgress('Upload cancelled');
    } else {
      console.error('Upload error:', error);
      showStatusMessage(`Upload failed: ${errorMessage}`, 'error');
      announceProgress(`Upload failed: ${errorMessage}`);
    }

    progressSection.classList.add('hidden');
    statusMessage.classList.remove('hidden');
    form.classList.remove('hidden');
    currentUpload = null;
  }
}

function showStatusMessage(message: string, type: 'success' | 'error'): void {
  statusMessage.textContent = message;
  statusMessage.className = type;
  statusMessage.classList.remove('hidden');
}

// ============================================================================
// FORM SUBMISSION
// ============================================================================

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const file = fileInput.files?.[0];
  const email = emailInput.value.trim();
  const title = titleInput.value.trim();
  const description = descriptionInput.value.trim();

  // Validate
  if (!file) {
    showValidationError('Please select a file to upload.');
    fileInput.focus();
    return;
  }

  if (!email) {
    showValidationError('Please enter your email address.');
    emailInput.focus();
    return;
  }

  if (!EMAIL_REGEX.test(email)) {
    showValidationError('Please enter a valid email address.');
    emailInput.focus();
    return;
  }

  submitBtn.disabled = true;
  await startUpload(file, email, title, description);
  submitBtn.disabled = false;
});

// ============================================================================
// CANCEL BUTTON
// ============================================================================

cancelBtn.addEventListener('click', () => {
  if (abortController) {
    abortController.abort();
  }
});

// ============================================================================
// ANOTHER FILE BUTTON
// ============================================================================

anotherBtn.addEventListener('click', () => {
  successSection.classList.add('hidden');
  form.reset();
  fileInfo.textContent = 'No file selected';
  form.classList.remove('hidden');
  form.focus();
});

// ============================================================================
// RESUME FUNCTIONALITY
// ============================================================================

function checkForPendingUpload(): void {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return;

  try {
    const parsed = JSON.parse(saved);
    const result = UploadStateSchema.safeParse(parsed);

    if (!result.success) {
      console.warn('Invalid saved upload state:', result.error.issues);
      localStorage.removeItem(STORAGE_KEY);
      return;
    }

    savedUpload = result.data;
    resumeFilename.textContent = savedUpload.fileName || savedUpload.key.split('/').pop() || 'Unknown';
    resumeBanner.classList.remove('hidden');
    announceProgress('Incomplete upload detected. You can resume or start fresh.');
  } catch (parseError) {
    console.warn('Failed to parse saved upload state:', parseError);
    localStorage.removeItem(STORAGE_KEY);
  }
}

resumeBtn.addEventListener('click', async () => {
  resumeError.classList.add('hidden');

  const file = fileInput.files?.[0];
  if (!file) {
    resumeError.textContent = 'Please select the file to resume uploading.';
    resumeError.classList.remove('hidden');
    fileInput.focus();
    return;
  }

  if (!savedUpload) return;

  const expectedFilename = savedUpload.fileName || savedUpload.key.split('/').pop();
  if (file.name !== expectedFilename) {
    resumeError.textContent = `Expected "${expectedFilename}" but got "${file.name}".`;
    resumeError.classList.remove('hidden');
    return;
  }

  if (savedUpload.fileSize && file.size !== savedUpload.fileSize) {
    resumeError.textContent = `File size mismatch. Expected ${formatBytes(savedUpload.fileSize)}, got ${formatBytes(file.size)}.`;
    resumeError.classList.remove('hidden');
    return;
  }

  const email = emailInput.value.trim();
  if (!email) {
    resumeError.textContent = 'Please enter your email address.';
    resumeError.classList.remove('hidden');
    emailInput.focus();
    return;
  }

  resumeBtn.disabled = true;
  freshBtn.disabled = true;

  try {
    const status = await apiCall<StatusResponse>('/status', {
      uploadId: savedUpload.uploadId,
      key: savedUpload.key,
    });

    if (status.status === 'completed_or_aborted') {
      resumeError.textContent = 'Upload was already completed or cancelled. Please start fresh.';
      resumeError.classList.remove('hidden');
      localStorage.removeItem(STORAGE_KEY);
      savedUpload = null;
      resumeBanner.classList.add('hidden');
      resumeBtn.disabled = false;
      freshBtn.disabled = false;
      return;
    }

    resumeBanner.classList.add('hidden');

    await startUpload(file, email, titleInput.value, descriptionInput.value, {
      ...savedUpload,
      completedParts: status.completedParts,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    resumeError.textContent = `Failed to resume: ${errorMessage}`;
    resumeError.classList.remove('hidden');
    // Re-show banner so user can retry without refreshing
    resumeBanner.classList.remove('hidden');
    currentUpload = null;
    resumeBtn.disabled = false;
    freshBtn.disabled = false;
  }
});

freshBtn.addEventListener('click', async () => {
  freshBtn.disabled = true;
  resumeBtn.disabled = true;

  if (savedUpload) {
    try {
      await apiCall<AbortResponse>('/abort', {
        uploadId: savedUpload.uploadId,
        key: savedUpload.key,
        submissionId: savedUpload.submissionId,
      });
    } catch (e) {
      console.warn('Failed to abort on server:', e);
    }
  }

  localStorage.removeItem(STORAGE_KEY);
  savedUpload = null;
  resumeBanner.classList.add('hidden');
  freshBtn.disabled = false;
  resumeBtn.disabled = false;
});

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
  checkForPendingUpload();
});
