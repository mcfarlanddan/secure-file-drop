// Secure File Drop - Multipart Uploader
const API_BASE = '/api';
const CHUNK_SIZE = 64 * 1024 * 1024; // 64MB
const CONCURRENT_UPLOADS = 5;
const PRESIGN_BATCH_SIZE = 10;

// DOM Elements
const form = document.getElementById('upload-form');
const fileInput = document.getElementById('file');
const fileInfo = document.getElementById('file-info');
const submitBtn = document.getElementById('submit-btn');
const progressSection = document.getElementById('progress-section');
const progressFilename = document.getElementById('progress-filename');
const progressPercent = document.getElementById('progress-percent');
const progressFill = document.getElementById('progress-fill');
const progressUploaded = document.getElementById('progress-uploaded');
const progressTotal = document.getElementById('progress-total');
const progressSpeed = document.getElementById('progress-speed');
const cancelBtn = document.getElementById('cancel-btn');
const statusMessage = document.getElementById('status-message');
const successSection = document.getElementById('success-section');
const successFilename = document.getElementById('success-filename');
const anotherBtn = document.getElementById('another-btn');

// State
let currentUpload = null;
let abortController = null;

// Format bytes to human readable
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Update file info display
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) {
    fileInfo.textContent = `${file.name} (${formatBytes(file.size)})`;
  } else {
    fileInfo.textContent = 'No file selected';
  }
});

// Drag and drop visual feedback
const fileInputWrapper = document.querySelector('.file-input-wrapper');
fileInputWrapper.addEventListener('dragover', (e) => {
  e.preventDefault();
  fileInputWrapper.classList.add('drag-over');
});
fileInputWrapper.addEventListener('dragleave', (e) => {
  e.preventDefault();
  fileInputWrapper.classList.remove('drag-over');
});
fileInputWrapper.addEventListener('drop', (e) => {
  fileInputWrapper.classList.remove('drag-over');
});

// API call helper
async function apiCall(endpoint, data) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'API request failed');
  }
  return response.json();
}

// Upload a single part
async function uploadPart(url, chunk, partNumber, signal) {
  const response = await fetch(url, {
    method: 'PUT',
    body: chunk,
    signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to upload part ${partNumber}`);
  }
  return response.headers.get('ETag');
}

// Main upload function
async function startUpload(file, email, title, description) {
  abortController = new AbortController();
  const signal = abortController.signal;

  const totalParts = Math.ceil(file.size / CHUNK_SIZE);
  const completedParts = [];
  let uploadedBytes = 0;
  let startTime = Date.now();

  // Update UI
  form.classList.add('hidden');
  progressSection.classList.remove('hidden');
  statusMessage.classList.add('hidden');
  progressFilename.textContent = file.name;
  progressTotal.textContent = formatBytes(file.size);

  try {
    // Step 1: Initiate multipart upload
    const initResponse = await apiCall('/initiate', {
      email,
      title,
      description,
      fileName: file.name,
      fileSize: file.size,
      contentType: file.type || 'application/octet-stream',
    });

    currentUpload = {
      submissionId: initResponse.submissionId,
      uploadId: initResponse.uploadId,
      key: initResponse.key,
    };

    // Save to localStorage for potential resume
    localStorage.setItem('securefiledrop_upload', JSON.stringify(currentUpload));

    // Step 2: Upload parts with concurrency control
    const partQueue = [];
    for (let i = 1; i <= totalParts; i++) {
      partQueue.push(i);
    }

    // Process parts in batches
    while (partQueue.length > 0) {
      if (signal.aborted) throw new Error('Upload cancelled');

      // Get presigned URLs for next batch
      const batchPartNumbers = partQueue.splice(0, PRESIGN_BATCH_SIZE);
      const presignResponse = await apiCall('/presign', {
        uploadId: currentUpload.uploadId,
        key: currentUpload.key,
        partNumbers: batchPartNumbers,
      });

      const urlMap = new Map(presignResponse.urls.map(u => [u.partNumber, u.url]));

      // Upload parts concurrently
      const uploadPromises = [];
      for (const partNumber of batchPartNumbers) {
        const start = (partNumber - 1) * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);
        const url = urlMap.get(partNumber);

        const uploadPromise = uploadPart(url, chunk, partNumber, signal)
          .then(etag => {
            completedParts.push({ PartNumber: partNumber, ETag: etag });
            uploadedBytes += chunk.size;

            // Update progress
            const percent = Math.round((uploadedBytes / file.size) * 100);
            progressPercent.textContent = `${percent}%`;
            progressFill.style.width = `${percent}%`;
            progressUploaded.textContent = formatBytes(uploadedBytes);

            // Calculate speed
            const elapsed = (Date.now() - startTime) / 1000;
            if (elapsed > 0) {
              const speed = uploadedBytes / elapsed;
              progressSpeed.textContent = `${formatBytes(speed)}/s`;
            }
          });

        uploadPromises.push(uploadPromise);

        // Limit concurrency
        if (uploadPromises.length >= CONCURRENT_UPLOADS) {
          await Promise.race(uploadPromises);
          // Remove completed promises
          for (let i = uploadPromises.length - 1; i >= 0; i--) {
            const status = await Promise.race([
              uploadPromises[i].then(() => 'done'),
              Promise.resolve('pending')
            ]);
            if (status === 'done') {
              uploadPromises.splice(i, 1);
            }
          }
        }
      }

      // Wait for remaining uploads in this batch
      await Promise.all(uploadPromises);
    }

    // Step 3: Complete multipart upload
    await apiCall('/complete', {
      uploadId: currentUpload.uploadId,
      key: currentUpload.key,
      parts: completedParts,
      submissionId: currentUpload.submissionId,
    });

    // Clear saved state
    localStorage.removeItem('securefiledrop_upload');
    const uploadedFileName = file.name;
    currentUpload = null;

    // Show success section
    progressSection.classList.add('hidden');
    successFilename.textContent = uploadedFileName;
    successSection.classList.remove('hidden');

  } catch (error) {
    if (error.message === 'Upload cancelled') {
      // Abort on server
      if (currentUpload) {
        try {
          await apiCall('/abort', {
            uploadId: currentUpload.uploadId,
            key: currentUpload.key,
          });
        } catch (e) {
          console.warn('Failed to abort upload on server:', e);
        }
      }
      localStorage.removeItem('securefiledrop_upload');
      statusMessage.textContent = 'Upload cancelled.';
      statusMessage.className = 'error';
    } else {
      console.error('Upload error:', error);
      statusMessage.textContent = `Upload failed: ${error.message}`;
      statusMessage.className = 'error';
    }

    progressSection.classList.add('hidden');
    statusMessage.classList.remove('hidden');
    form.classList.remove('hidden');
    currentUpload = null;
  }
}

// Form submission
form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const file = fileInput.files[0];
  const email = document.getElementById('email').value;
  const title = document.getElementById('title').value;
  const description = document.getElementById('description').value;

  if (!file) {
    alert('Please select a file');
    return;
  }

  if (!email) {
    alert('Please enter your email');
    return;
  }

  submitBtn.disabled = true;
  await startUpload(file, email, title, description);
  submitBtn.disabled = false;
});

// Cancel button
cancelBtn.addEventListener('click', () => {
  if (abortController) {
    abortController.abort();
  }
});

// Upload another file button
anotherBtn.addEventListener('click', () => {
  successSection.classList.add('hidden');
  form.reset();
  fileInfo.textContent = 'No file selected';
  form.classList.remove('hidden');
});

// Check for pending upload on page load (resume support)
window.addEventListener('load', async () => {
  const saved = localStorage.getItem('securefiledrop_upload');
  if (saved) {
    const upload = JSON.parse(saved);
    // Check if upload is still valid
    try {
      const status = await apiCall('/status', {
        uploadId: upload.uploadId,
        key: upload.key,
      });
      if (status.completedParts && status.completedParts.length > 0) {
        const resume = confirm(
          `Found incomplete upload for "${upload.key.split('/').pop()}". ` +
          `${status.completedParts.length} parts already uploaded. Resume?`
        );
        if (!resume) {
          localStorage.removeItem('securefiledrop_upload');
        }
        // Note: Full resume implementation would need to re-select file
        // For simplicity, just clearing for now
        localStorage.removeItem('securefiledrop_upload');
      } else {
        localStorage.removeItem('securefiledrop_upload');
      }
    } catch (e) {
      localStorage.removeItem('securefiledrop_upload');
    }
  }
});
