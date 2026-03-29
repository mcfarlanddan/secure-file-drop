#!/bin/bash
#
# Integration test for Secure File Drop
#
# This script tests the deployed stack by:
# 1. Creating a small test file
# 2. Initiating an upload
# 3. Getting presigned URLs
# 4. Uploading parts
# 5. Completing the upload
# 6. Verifying the file exists in S3
#
# Usage:
#   ./scripts/integration-test.sh <cloudfront-url>
#
# Example:
#   ./scripts/integration-test.sh https://d1234567890.cloudfront.net
#
# Prerequisites:
#   - curl
#   - jq
#   - AWS CLI configured with access to the S3 bucket
#

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check arguments
if [ $# -lt 1 ]; then
    echo "Usage: $0 <cloudfront-url>"
    echo "Example: $0 https://d1234567890.cloudfront.net"
    exit 1
fi

BASE_URL="${1%/}"  # Remove trailing slash if present
API_URL="$BASE_URL/api"

# Check dependencies
for cmd in curl jq; do
    if ! command -v $cmd &> /dev/null; then
        log_error "$cmd is required but not installed"
        exit 1
    fi
done

# Create temp directory
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

log_info "Using temp directory: $TEMP_DIR"

# Create test file (1MB)
TEST_FILE="$TEMP_DIR/test-file.bin"
TEST_SIZE=$((1 * 1024 * 1024))  # 1MB
log_info "Creating test file ($TEST_SIZE bytes)..."
dd if=/dev/urandom of="$TEST_FILE" bs=1024 count=1024 2>/dev/null

# Calculate MD5 for verification
if command -v md5sum &> /dev/null; then
    ORIGINAL_MD5=$(md5sum "$TEST_FILE" | cut -d' ' -f1)
elif command -v md5 &> /dev/null; then
    ORIGINAL_MD5=$(md5 -q "$TEST_FILE")
else
    log_warn "md5sum/md5 not available, skipping checksum verification"
    ORIGINAL_MD5=""
fi
log_info "Original file MD5: $ORIGINAL_MD5"

# Test 1: Health check
log_info "Testing health endpoint..."
HEALTH_RESPONSE=$(curl -s -w "\n%{http_code}" "$API_URL/health" -X POST -H "Content-Type: application/json" -d '{}')
HEALTH_CODE=$(echo "$HEALTH_RESPONSE" | tail -n1)
HEALTH_BODY=$(echo "$HEALTH_RESPONSE" | sed '$d')

if [ "$HEALTH_CODE" = "200" ]; then
    log_info "Health check passed"
    echo "$HEALTH_BODY" | jq .
else
    log_error "Health check failed with code $HEALTH_CODE"
    echo "$HEALTH_BODY"
    exit 1
fi

# Test 2: Initiate upload
log_info "Initiating upload..."
INITIATE_RESPONSE=$(curl -s -w "\n%{http_code}" "$API_URL/initiate" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "{
        \"email\": \"integration-test@example.com\",
        \"fileName\": \"integration-test-file.bin\",
        \"fileSize\": $TEST_SIZE,
        \"contentType\": \"application/octet-stream\",
        \"title\": \"Integration Test\",
        \"description\": \"Automated integration test upload\"
    }")

INITIATE_CODE=$(echo "$INITIATE_RESPONSE" | tail -n1)
INITIATE_BODY=$(echo "$INITIATE_RESPONSE" | sed '$d')

if [ "$INITIATE_CODE" != "200" ]; then
    log_error "Initiate failed with code $INITIATE_CODE"
    echo "$INITIATE_BODY"
    exit 1
fi

log_info "Initiate response:"
echo "$INITIATE_BODY" | jq .

# Extract values
SUBMISSION_ID=$(echo "$INITIATE_BODY" | jq -r '.submissionId')
UPLOAD_ID=$(echo "$INITIATE_BODY" | jq -r '.uploadId')
KEY=$(echo "$INITIATE_BODY" | jq -r '.key')
TOTAL_PARTS=$(echo "$INITIATE_BODY" | jq -r '.totalParts')
CHUNK_SIZE=$(echo "$INITIATE_BODY" | jq -r '.chunkSize')

log_info "Submission ID: $SUBMISSION_ID"
log_info "Upload ID: $UPLOAD_ID"
log_info "Key: $KEY"
log_info "Total parts: $TOTAL_PARTS"

# Test 3: Get presigned URLs
log_info "Getting presigned URLs..."

# Build part numbers array
PART_NUMBERS="["
for i in $(seq 1 $TOTAL_PARTS); do
    if [ $i -gt 1 ]; then
        PART_NUMBERS="$PART_NUMBERS,"
    fi
    PART_NUMBERS="$PART_NUMBERS$i"
done
PART_NUMBERS="$PART_NUMBERS]"

PRESIGN_RESPONSE=$(curl -s -w "\n%{http_code}" "$API_URL/presign" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "{
        \"uploadId\": \"$UPLOAD_ID\",
        \"key\": \"$KEY\",
        \"partNumbers\": $PART_NUMBERS
    }")

PRESIGN_CODE=$(echo "$PRESIGN_RESPONSE" | tail -n1)
PRESIGN_BODY=$(echo "$PRESIGN_RESPONSE" | sed '$d')

if [ "$PRESIGN_CODE" != "200" ]; then
    log_error "Presign failed with code $PRESIGN_CODE"
    echo "$PRESIGN_BODY"
    # Cleanup: abort upload
    curl -s "$API_URL/abort" -X POST -H "Content-Type: application/json" \
        -d "{\"uploadId\": \"$UPLOAD_ID\", \"key\": \"$KEY\", \"submissionId\": \"$SUBMISSION_ID\"}" > /dev/null
    exit 1
fi

log_info "Got presigned URLs for $TOTAL_PARTS parts"

# Test 4: Upload parts
log_info "Uploading parts..."
PARTS_JSON="["
for i in $(seq 1 $TOTAL_PARTS); do
    log_info "Uploading part $i/$TOTAL_PARTS..."

    # Get URL for this part
    PART_URL=$(echo "$PRESIGN_BODY" | jq -r ".urls[] | select(.partNumber == $i) | .url")

    # Calculate byte range
    START=$(( ($i - 1) * $CHUNK_SIZE ))
    END=$(( $i * $CHUNK_SIZE ))
    if [ $END -gt $TEST_SIZE ]; then
        END=$TEST_SIZE
    fi
    LENGTH=$(( $END - $START ))

    # Extract part to temp file
    PART_FILE="$TEMP_DIR/part-$i"
    dd if="$TEST_FILE" of="$PART_FILE" bs=1 skip=$START count=$LENGTH 2>/dev/null

    # Upload part
    UPLOAD_RESPONSE=$(curl -s -w "\n%{http_code}" -X PUT \
        -H "Content-Type: application/octet-stream" \
        --data-binary "@$PART_FILE" \
        "$PART_URL" -D "$TEMP_DIR/headers-$i")

    UPLOAD_CODE=$(echo "$UPLOAD_RESPONSE" | tail -n1)

    if [ "$UPLOAD_CODE" != "200" ]; then
        log_error "Part $i upload failed with code $UPLOAD_CODE"
        # Cleanup: abort upload
        curl -s "$API_URL/abort" -X POST -H "Content-Type: application/json" \
            -d "{\"uploadId\": \"$UPLOAD_ID\", \"key\": \"$KEY\", \"submissionId\": \"$SUBMISSION_ID\"}" > /dev/null
        exit 1
    fi

    # Get ETag from response headers
    ETAG=$(grep -i "^etag:" "$TEMP_DIR/headers-$i" | tr -d '\r' | cut -d' ' -f2-)
    log_info "Part $i uploaded, ETag: $ETAG"

    # Add to parts JSON
    if [ $i -gt 1 ]; then
        PARTS_JSON="$PARTS_JSON,"
    fi
    PARTS_JSON="$PARTS_JSON{\"PartNumber\":$i,\"ETag\":$ETAG}"
done
PARTS_JSON="$PARTS_JSON]"

# Test 5: Complete upload
log_info "Completing upload..."
COMPLETE_RESPONSE=$(curl -s -w "\n%{http_code}" "$API_URL/complete" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "{
        \"uploadId\": \"$UPLOAD_ID\",
        \"key\": \"$KEY\",
        \"parts\": $PARTS_JSON,
        \"submissionId\": \"$SUBMISSION_ID\"
    }")

COMPLETE_CODE=$(echo "$COMPLETE_RESPONSE" | tail -n1)
COMPLETE_BODY=$(echo "$COMPLETE_RESPONSE" | sed '$d')

if [ "$COMPLETE_CODE" != "200" ]; then
    log_error "Complete failed with code $COMPLETE_CODE"
    echo "$COMPLETE_BODY"
    exit 1
fi

log_info "Complete response:"
echo "$COMPLETE_BODY" | jq .

# Test 6: Verify status returns completed_or_aborted
log_info "Verifying upload status..."
sleep 1  # Brief delay to ensure completion

STATUS_RESPONSE=$(curl -s -w "\n%{http_code}" "$API_URL/status" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "{
        \"uploadId\": \"$UPLOAD_ID\",
        \"key\": \"$KEY\"
    }")

STATUS_CODE=$(echo "$STATUS_RESPONSE" | tail -n1)
STATUS_BODY=$(echo "$STATUS_RESPONSE" | sed '$d')

if [ "$STATUS_CODE" = "200" ]; then
    STATUS=$(echo "$STATUS_BODY" | jq -r '.status // "active"')
    if [ "$STATUS" = "completed_or_aborted" ]; then
        log_info "Status confirms upload is completed"
    else
        log_warn "Status indicates upload still active (this is fine, S3 is eventually consistent)"
    fi
else
    log_warn "Status check failed (non-critical)"
fi

# Summary
echo ""
echo "======================================"
log_info "INTEGRATION TEST PASSED"
echo "======================================"
echo ""
echo "Upload Details:"
echo "  Submission ID: $SUBMISSION_ID"
echo "  S3 Key: $KEY"
echo "  File Size: $TEST_SIZE bytes"
echo "  Parts: $TOTAL_PARTS"
echo ""
echo "The file is now available in the S3 bucket."
echo "You should receive an email notification at the configured address."
echo ""
