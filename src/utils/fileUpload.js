const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

/**
 * Save a file to disk from base64 string
 * @param {string} base64String - Base64 encoded file string (data:image/...;base64,... or data:application/pdf;base64,...)
 * @param {string} prefix - Prefix for the filename (e.g., "bill", "attachment")
 * @returns {Promise<{fileName: string, filePath: string, mimeType: string, fileSize: number}>} - File info
 */
async function saveFileToDisk(base64String, prefix = "file") {
  if (!base64String) {
    return null;
  }

  // Check if it's a data URL
  const matches = base64String.match(/^data:(.+);base64,(.+)$/);
  if (!matches) {
    throw new Error("Invalid file format. Expected data URL.");
  }

  const mimeType = matches[1];
  const data = matches[2];

  // Validate file type (images or PDFs)
  const allowedMimeTypes = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'image/webp',
    'application/pdf'
  ];

  if (!allowedMimeTypes.includes(mimeType)) {
    throw new Error("Invalid file type. Only images (JPEG, PNG, GIF, WebP) and PDFs are allowed.");
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
    'application/pdf': 'pdf'
  };
  const extension = mimeToExt[mimeType] || 'bin';

  // Generate unique filename
  const uniqueId = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
  const fileName = `${prefix}-${Date.now()}-${uniqueId}.${extension}`;

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

module.exports = {
  saveFileToDisk,
  deleteFileFromDisk,
  getFilePath
};

