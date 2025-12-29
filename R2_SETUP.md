# Cloudflare R2 Setup Guide

This guide explains how to configure Cloudflare R2 object storage for payment screenshot uploads.

## Prerequisites

1. A Cloudflare account with R2 enabled
2. An R2 bucket created (e.g., "hissabbook")
3. R2 API credentials (Access Key ID and Secret Access Key)

## Step 1: Create R2 Bucket

1. Log in to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Navigate to **R2 object storage**
3. Click **"+ Create bucket"**
4. Name your bucket (e.g., "hissabbook")
5. Choose a location (optional)

## Step 2: Get R2 API Credentials

1. In the R2 dashboard, go to **"Manage R2 API Tokens"**
2. Click **"Create API token"**
3. Set permissions:
   - **Object Read & Write** (for uploads and downloads)
4. Copy the following:
   - **Access Key ID**
   - **Secret Access Key**

## Step 3: Get R2 Endpoint URL

1. In the R2 dashboard, note your **Account ID**
2. Your R2 endpoint will be: `https://<account-id>.r2.cloudflarestorage.com`
   - Example: `https://81f85a0bb17bfc7c1d11850ab13b.r2.cloudflarestorage.com`

## Step 4: Configure Public Access (Optional)

If you want to access files directly via URL:

### Option A: Use R2.dev Domain (Free)
1. In your bucket settings, enable **"Public Access"**
2. Your public URL will be: `https://<bucket-name>.<account-id>.r2.cloudflarestorage.com`
   - Example: `https://hissabbook.81f85a0bb17bfc7c1d11850ab13b.r2.cloudflarestorage.com`

### Option B: Use Custom Domain (Recommended for Production)
1. In your bucket settings, add a custom domain
2. Configure DNS records as instructed
3. Use your custom domain as the public URL

## Step 5: Add Environment Variables

Add the following to your `hissabbook-nodejs-backend/.env` file:

```env
# Cloudflare R2 Configuration
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=your-access-key-id
R2_SECRET_ACCESS_KEY=your-secret-access-key
R2_BUCKET_NAME=hissabbook
R2_PUBLIC_URL=https://hissabbook.<account-id>.r2.cloudflarestorage.com
```

### Example:

```env
# Cloudflare R2 Configuration
R2_ENDPOINT=https://81f85a0bb17bfc7c1d11850ab13b.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=abc123def456ghi789
R2_SECRET_ACCESS_KEY=xyz789uvw456rst123
R2_BUCKET_NAME=hissabbook
R2_PUBLIC_URL=https://hissabbook.81f85a0bb17bfc7c1d11850ab13b.r2.cloudflarestorage.com
```

## Step 6: Install Dependencies

The AWS SDK for S3 (which works with R2) is already added to `package.json`. Install it:

```bash
cd hissabbook-nodejs-backend
npm install
```

## Step 7: Restart Backend

Restart your backend server to load the new environment variables:

```bash
# If using Docker
docker restart hissabbook-backend

# If running locally
npm start
```

## How It Works

1. **Upload**: When a user uploads a payment screenshot, it's uploaded to R2 instead of local disk
2. **Storage**: The R2 URL is stored in the `proof_filename` column in the database
3. **Access**: Files are accessed directly from R2 via their public URLs
4. **Fallback**: If R2 is not configured, the system automatically falls back to local disk storage

## Testing

1. Submit a payout request with a payment screenshot
2. Check the database - `proof_filename` should contain an R2 URL (starts with `http`)
3. Try accessing the URL directly in a browser - it should show the uploaded file

## Troubleshooting

### Files not uploading to R2
- Check that all R2 environment variables are set correctly
- Verify R2 API credentials have correct permissions
- Check backend logs for error messages

### Files not accessible
- Ensure R2 bucket has public access enabled (if using public URLs)
- Verify `R2_PUBLIC_URL` is set correctly
- Check that custom domain DNS is configured (if using custom domain)

### Fallback to disk storage
- If R2 upload fails, the system automatically saves to local disk
- Check logs for R2 upload errors
- Verify R2 credentials and endpoint are correct

## Security Notes

- Keep your R2 API credentials secure
- Use environment variables, never commit credentials to git
- Consider using IAM-like permissions for production
- Enable bucket versioning for important files
- Set up lifecycle policies to manage old files
