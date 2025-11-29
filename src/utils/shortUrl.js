// Short URL utility for generating and managing short URLs
const crypto = require('crypto');

/**
 * Generate a short code for a URL
 * @param {number} length - Length of the short code (default: 8)
 * @returns {string} Short code
 */
function generateShortCode(length = 8) {
  // Generate a random string using crypto
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  const randomBytes = crypto.randomBytes(length);
  
  for (let i = 0; i < length; i++) {
    result += chars[randomBytes[i] % chars.length];
  }
  
  return result;
}

/**
 * Create a short URL for a given original URL
 * @param {object} pg - PostgreSQL client
 * @param {string} originalUrl - The original long URL
 * @param {Date} expiresAt - Optional expiration date
 * @returns {Promise<{shortCode: string, shortUrl: string}>}
 */
async function createShortUrl(pg, originalUrl, expiresAt = null) {
  // Check if short_urls table exists
  const tableCheck = await pg.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name = 'short_urls'
    );
  `);

  if (!tableCheck.rows[0]?.exists) {
    const error = new Error('Short URLs table does not exist. Please run migrations: npm run migrate in hissabbook-nodejs-backend');
    console.error('Short URLs table check failed:', error.message);
    throw error;
  }

  // Generate a unique short code
  let shortCode;
  let attempts = 0;
  const maxAttempts = 10;
  
  while (attempts < maxAttempts) {
    shortCode = generateShortCode(8);
    
    // Check if this code already exists
    const existing = await pg.query(
      'SELECT id FROM public.short_urls WHERE short_code = $1',
      [shortCode]
    );
    
    if (existing.rows.length === 0) {
      // Code is unique, use it
      break;
    }
    
    attempts++;
    
    // If we've tried too many times, make the code longer
    if (attempts >= maxAttempts) {
      shortCode = generateShortCode(12);
      break;
    }
  }
  
  // Insert the short URL mapping
  const result = await pg.query(
    `INSERT INTO public.short_urls (short_code, original_url, expires_at)
     VALUES ($1, $2, $3)
     RETURNING id, short_code, original_url, expires_at`,
    [shortCode, originalUrl, expiresAt]
  );
  
  // Get base URL from environment or construct from original URL
  let baseUrl = process.env.FRONTEND_URL || process.env.NEXT_PUBLIC_FRONTEND_URL;
  
  // If not set, try to extract from original URL
  if (!baseUrl && originalUrl) {
    try {
      const urlObj = new URL(originalUrl);
      baseUrl = `${urlObj.protocol}//${urlObj.host}`;
    } catch (e) {
      // If URL parsing fails, fall back to default
      baseUrl = 'http://localhost:3000';
    }
  }
  
  // Final fallback
  if (!baseUrl) {
    baseUrl = process.env.NODE_ENV === 'production' 
      ? 'https://hissabbook.com' 
      : 'http://localhost:3000';
  }
  
  const shortUrl = `${baseUrl}/s/${shortCode}`;
  
  return {
    shortCode: result.rows[0].short_code,
    shortUrl,
    id: result.rows[0].id,
  };
}

/**
 * Get the original URL from a short code
 * @param {object} pg - PostgreSQL client
 * @param {string} shortCode - The short code
 * @returns {Promise<{originalUrl: string, clickCount: number} | null>}
 */
async function getOriginalUrl(pg, shortCode) {
  const result = await pg.query(
    `SELECT original_url, click_count, expires_at
     FROM public.short_urls
     WHERE short_code = $1`,
    [shortCode]
  );
  
  if (result.rows.length === 0) {
    return null;
  }
  
  const row = result.rows[0];
  
  // Check if the URL has expired
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return null; // URL has expired
  }
  
  // Increment click count
  await pg.query(
    `UPDATE public.short_urls
     SET click_count = click_count + 1,
         last_clicked_at = now()
     WHERE short_code = $1`,
    [shortCode]
  );
  
  return {
    originalUrl: row.original_url,
    clickCount: row.click_count + 1,
  };
}

module.exports = {
  generateShortCode,
  createShortUrl,
  getOriginalUrl,
};

