const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');

// Get R2 configuration from environment
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'hissabbook';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL; // Custom domain or R2.dev URL

// Initialize S3 client for Cloudflare R2 (only if credentials are available)
// R2 is S3-compatible, so we use the AWS SDK
let s3Client = null;

function getS3Client() {
  if (!s3Client && R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY) {
    s3Client = new S3Client({
      region: 'auto', // R2 uses 'auto' as the region
      endpoint: R2_ENDPOINT,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3Client;
}

/**
 * Upload a file to Cloudflare R2 from base64 string
 * @param {string} base64String - Base64 encoded file string (data:image/...;base64,... or data:application/pdf;base64,...)
 * @param {string} prefix - Prefix for the filename (e.g., "payout", "proof")
 * @param {string} pathPrefix - Optional path prefix for organizing files (e.g., "screenshots/")
 * @returns {Promise<{fileName: string, url: string, fileSize: number}>} - File info with R2 URL
 */
async function uploadToR2(base64String, prefix = 'file', pathPrefix = '') {
  if (!base64String) {
    return null;
  }

  // Check if it's a data URL
  const matches = base64String.match(/^data:(.+);base64,(.+)$/);
  if (!matches) {
    throw new Error('Invalid file format. Expected data URL.');
  }

  const mimeType = matches[1];
  const data = matches[2];

  // Validate file type (images and PDFs)
  const allowedMimeTypes = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'image/webp',
    'application/pdf',
  ];

  if (!allowedMimeTypes.includes(mimeType)) {
    throw new Error('Invalid file type. Only images (JPEG, PNG, GIF, WebP) and PDFs are allowed.');
  }

  const buffer = Buffer.from(data, 'base64');
  const fileSize = buffer.length;

  // Determine file extension from MIME type
  const mimeToExt = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
  };
  const extension = mimeToExt[mimeType] || 'bin';

  // Generate unique filename
  const uniqueId = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
  const fileName = `${prefix}-${Date.now()}-${uniqueId}.${extension}`;
  
  // Construct the key with path prefix if provided
  const key = pathPrefix ? `${pathPrefix}${fileName}` : fileName;

  // Get S3 client (will be null if R2 not configured)
  const client = getS3Client();
  if (!client) {
    throw new Error('R2 S3 client not initialized. Check R2 environment variables.');
  }

  // Upload to R2
  const command = new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
    // Make file publicly accessible (if using public bucket)
    // ACL: 'public-read', // R2 doesn't support ACL, use public bucket settings instead
  });

  try {
    await client.send(command);
    
    // Construct public URL
    // If R2_PUBLIC_URL is set (custom domain), use it
    // Otherwise, construct R2.dev URL: https://<bucket-name>.<account-id>.r2.cloudflarestorage.com/<key>
    let fileUrl;
    if (R2_PUBLIC_URL) {
      // Custom domain or R2.dev URL
      fileUrl = R2_PUBLIC_URL.endsWith('/') 
        ? `${R2_PUBLIC_URL}${key}`
        : `${R2_PUBLIC_URL}/${key}`;
    } else {
      // Fallback: construct R2.dev URL from endpoint
      // Extract account ID from endpoint if available
      const endpoint = process.env.R2_ENDPOINT || '';
      const accountIdMatch = endpoint.match(/https?:\/\/([^.]+)\.r2\.cloudflarestorage\.com/);
      if (accountIdMatch) {
        const accountId = accountIdMatch[1];
        fileUrl = `https://${R2_BUCKET_NAME}.${accountId}.r2.cloudflarestorage.com/${key}`;
      } else {
        // Last resort: use endpoint + bucket + key
        fileUrl = `${endpoint}/${R2_BUCKET_NAME}/${key}`;
      }
    }

    return {
      fileName: key, // Return the full key including path
      url: fileUrl,
      fileSize,
      mimeType,
    };
  } catch (error) {
    throw new Error(`Failed to upload file to R2: ${error.message}`);
  }
}

/**
 * Delete a file from R2
 * @param {string} fileName - Name of the file to delete
 * @returns {Promise<boolean>} - True if deleted, false otherwise
 */
async function deleteFromR2(fileName) {
  if (!fileName) {
    return false;
  }

  const client = getS3Client();
  if (!client) {
    console.warn('R2 S3 client not initialized. Cannot delete file from R2.');
    return false;
  }

  try {
    const command = new DeleteObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: fileName,
    });

    await client.send(command);
    return true;
  } catch (error) {
    if (error.name === 'NoSuchKey') {
      // File doesn't exist, consider it deleted
      return true;
    }
    throw error;
  }
}

/**
 * Upload payout proof to R2 (wrapper for uploadToR2)
 * Stores files in the screenshots/ directory
 * @param {string} base64String - Base64 encoded proof file
 * @returns {Promise<{fileName: string, url: string, fileSize: number}>} - File info with R2 URL
 */
async function uploadProofToR2(base64String) {
  // Upload to screenshots/ directory
  return uploadToR2(base64String, 'payout', 'screenshots/');
}

/**
 * Upload bill/attachment to R2 (wrapper for uploadToR2)
 * Stores files in the screenshots/ directory (same as payout proofs)
 * @param {string} base64String - Base64 encoded attachment file
 * @returns {Promise<{fileName: string, url: string, fileSize: number}>} - File info with R2 URL
 */
async function uploadAttachmentToR2(base64String) {
  // Upload to screenshots/ directory (same folder as payout proofs)
  return uploadToR2(base64String, 'bill', 'screenshots/');
}

module.exports = {
  uploadToR2,
  deleteFromR2,
  uploadProofToR2,
  uploadAttachmentToR2,
};
