const QRCode = require('qrcode');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

/**
 * Generate UPI QR code and save to disk
 * @param {string} upiId - UPI ID (e.g., "9876543210@hissabbook")
 * @param {string} name - User name for QR code (optional)
 * @returns {Promise<string|null>} - Filename of the saved QR code image or null
 */
async function generateAndSaveUpiQrCode(upiId, name = null) {
  if (!upiId) {
    return null;
  }

  try {
    // Create UPI payment URL
    // Format: upi://pay?pa={upi_id}&pn={name}&am=&cu=INR
    const upiUrl = name 
      ? `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(name)}&am=&cu=INR`
      : `upi://pay?pa=${encodeURIComponent(upiId)}&am=&cu=INR`;

    // Generate QR code as buffer
    const qrCodeBuffer = await QRCode.toBuffer(upiUrl, {
      type: 'png',
      width: 300,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });

    // Generate unique filename
    const uniqueId = typeof crypto.randomUUID === 'function' 
      ? crypto.randomUUID() 
      : crypto.randomBytes(16).toString('hex');
    const fileName = `qr-code-${Date.now()}-${uniqueId}.png`;
    
    // Create uploads directory if it doesn't exist
    const uploadDir = path.join(process.cwd(), 'uploads');
    await fs.mkdir(uploadDir, { recursive: true });
    
    // Save QR code to disk
    const filePath = path.join(uploadDir, fileName);
    await fs.writeFile(filePath, qrCodeBuffer);
    
    return fileName;
  } catch (error) {
    console.error('Error generating UPI QR code:', error);
    return null;
  }
}

module.exports = {
  generateAndSaveUpiQrCode,
};



