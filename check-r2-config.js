// Quick script to check R2 configuration
require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });

console.log('=== R2 Configuration Check ===\n');

const requiredVars = [
  'R2_ENDPOINT',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'R2_PUBLIC_URL'
];

let allConfigured = true;

requiredVars.forEach(varName => {
  const value = process.env[varName];
  if (value) {
    // Mask sensitive values
    if (varName.includes('SECRET') || varName.includes('KEY')) {
      const masked = value.substring(0, 4) + '...' + value.substring(value.length - 4);
      console.log(`✓ ${varName}: ${masked}`);
    } else {
      console.log(`✓ ${varName}: ${value}`);
    }
  } else {
    console.log(`✗ ${varName}: NOT SET`);
    if (varName !== 'R2_PUBLIC_URL') {
      allConfigured = false;
    }
  }
});

console.log('\n=== Status ===');
if (allConfigured) {
  console.log('✓ R2 is properly configured!');
  console.log('Files will be uploaded to Cloudflare R2.');
} else {
  console.log('✗ R2 is NOT fully configured.');
  console.log('Files will be stored on the server (disk storage).');
  console.log('\nTo enable R2:');
  console.log('1. Add the missing environment variables to .env file');
  console.log('2. Restart the backend server');
  console.log('\nSee R2_SETUP.md for detailed instructions.');
}



