const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

/**
 * Save a file to disk from base64 string
 * @param {string} base64String - Base64 encoded file string (data:image/...;base64,... or data:application/pdf;base64,...)
 * @param {string} prefix - Prefix for the filename (e.g., "bill", "attachment")
 * @param {string} customFileName - Optional custom filename (without extension). If provided, this will be used instead of auto-generated name.
 * @returns {Promise<{fileName: string, filePath: string, mimeType: string, fileSize: number}>} - File info
 */
async function saveFileToDisk(base64String, prefix = "file", customFileName = null) {
  if (!base64String) {
    return null;
  }

  // Check if it's a data URL
  const matches = base64String.match(/^data:(.+);base64,(.+)$/);
  if (!matches) {
    throw new Error("Invalid file format. Expected data URL.");
  }

  let mimeType = matches[1];
  const data = matches[2];

  // Validate file type (images, PDFs, or APK files)
  const allowedMimeTypes = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'image/webp',
    'application/pdf',
    'application/vnd.android.package-archive',
    'application/octet-stream' // Some APKs might have this MIME type
  ];

  // If prefix is 'apk' and MIME type is application/octet-stream, treat it as APK
  if (prefix === 'apk' && mimeType === 'application/octet-stream') {
    mimeType = 'application/vnd.android.package-archive';
  }

  if (!allowedMimeTypes.includes(mimeType)) {
    throw new Error("Invalid file type. Only images (JPEG, PNG, GIF, WebP), PDFs, and APK files are allowed.");
  }

  const buffer = Buffer.from(data, "base64");
  const fileSize = buffer.length;

  // Determine file extension from MIME type
  const mimeToExt = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
    'application/vnd.android.package-archive': 'apk',
    'application/octet-stream': prefix === 'apk' ? 'apk' : 'bin' // Only treat as APK if prefix indicates it
  };
  const extension = mimeToExt[mimeType] || 'bin';

  // Generate filename - use custom filename if provided, otherwise generate unique name
  let fileName;
  if (customFileName) {
    // Sanitize custom filename to prevent directory traversal and ensure valid filename
    const sanitized = customFileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    fileName = `${sanitized}.${extension}`;
  } else {
    // Generate unique filename
    const uniqueId = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString('hex');
    fileName = `${prefix}-${Date.now()}-${uniqueId}.${extension}`;
  }

  // Create uploads directory if it doesn't exist
  const uploadDir = path.join(process.cwd(), 'uploads');
  await fs.mkdir(uploadDir, { recursive: true });

  const filePath = path.join(uploadDir, fileName);
  await fs.writeFile(filePath, buffer);

  return {
    fileName,
    filePath,
    mimeType,
    fileSize,
    fileType: mimeType.startsWith('image/') ? 'image' : 'pdf'
  };
}

/**
 * Delete a file from disk
 * @param {string} fileName - Name of the file to delete
 * @returns {Promise<boolean>} - True if deleted, false otherwise
 */
async function deleteFileFromDisk(fileName) {
  if (!fileName) {
    return false;
  }

  try {
    const filePath = path.join(process.cwd(), 'uploads', fileName);
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      // File doesn't exist, consider it deleted
      return true;
    }
    throw error;
  }
}

/**
 * Get the full path to an uploaded file
 * @param {string} fileName - Name of the file
 * @returns {string} - Full path to the file
 */
function getFilePath(fileName) {
  if (!fileName) {
    return null;
  }
  return path.join(process.cwd(), 'uploads', fileName);
}

/**
 * Save a base64 image to disk (wrapper for saveFileToDisk for images)
 * @param {string} base64String - Base64 encoded image string (data:image/...;base64,...)
 * @param {string} prefix - Prefix for the filename (e.g., "qr-code", "payout")
 * @returns {Promise<string|null>} - Filename of the saved image or null
 */
async function saveImageToDisk(base64String, prefix = "image") {
  if (!base64String) {
    return null;
  }
  
  try {
    const result = await saveFileToDisk(base64String, prefix);
    return result ? result.fileName : null;
  } catch (error) {
    throw error;
  }
}

/**
 * Delete an image from disk (alias for deleteFileFromDisk)
 * @param {string} fileName - Name of the file to delete
 * @returns {Promise<boolean>} - True if deleted, false otherwise
 */
async function deleteImageFromDisk(fileName) {
  return deleteFileFromDisk(fileName);
}

module.exports = {
  saveFileToDisk,
  deleteFileFromDisk,
  getFilePath,
  saveImageToDisk,
  deleteImageFromDisk,
};



