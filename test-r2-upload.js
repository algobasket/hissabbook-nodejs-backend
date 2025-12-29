// Test script to verify R2 upload works
require('dotenv').config();

const { uploadProofToR2 } = require('./src/utils/r2Upload');

// Create a test image (1x1 pixel PNG in base64)
const testImageBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function testUpload() {
  console.log('=== Testing R2 Upload ===\n');
  
  // Check configuration
  console.log('Configuration:');
  console.log('R2_ENDPOINT:', process.env.R2_ENDPOINT ? '✓ SET' : '✗ NOT SET');
  console.log('R2_ACCESS_KEY_ID:', process.env.R2_ACCESS_KEY_ID ? '✓ SET' : '✗ NOT SET');
  console.log('R2_SECRET_ACCESS_KEY:', process.env.R2_SECRET_ACCESS_KEY ? '✓ SET' : '✗ NOT SET');
  console.log('R2_BUCKET_NAME:', process.env.R2_BUCKET_NAME || 'hissabbook (default)');
  console.log('R2_PUBLIC_URL:', process.env.R2_PUBLIC_URL || 'NOT SET');
  console.log('');
  
  if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.error('❌ R2 configuration is incomplete. Cannot test upload.');
    process.exit(1);
  }
  
  try {
    console.log('Uploading test image to R2...');
    const result = await uploadProofToR2(testImageBase64);
    
    console.log('\n✅ Upload successful!');
    console.log('File name:', result.fileName);
    console.log('File URL:', result.url);
    console.log('File size:', result.fileSize, 'bytes');
    console.log('MIME type:', result.mimeType);
    console.log('\nYou can access the file at:', result.url);
    
  } catch (error) {
    console.error('\n❌ Upload failed!');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

testUpload();
