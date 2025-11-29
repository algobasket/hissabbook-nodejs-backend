// Short URL redirect route (public endpoint)

async function shortUrlRoutes(app) {
  // Get original URL for short code (returns JSON for API calls)
  app.get('/s/:shortCode', async (request, reply) => {
    try {
      const { shortCode } = request.params;
      
      // Validate short code format (alphanumeric, 6-20 characters)
      if (!/^[a-zA-Z0-9]{6,20}$/.test(shortCode)) {
        return reply.code(400).send({ message: 'Invalid short code format' });
      }
      
      // Check if short_urls table exists first
      const tableCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'short_urls'
        );
      `);

      if (!tableCheck.rows[0]?.exists) {
        request.log.error({ shortCode }, 'Short URLs table does not exist');
        return reply.code(500).send({ 
          message: 'Short URLs table does not exist. Please run migrations.',
          shortCode 
        });
      }

      // Get original URL from database
      const { getOriginalUrl } = require('../utils/shortUrl');
      const urlData = await getOriginalUrl(app.pg, shortCode);
      
      if (!urlData) {
        request.log.warn({ shortCode }, 'Short URL not found in database');
        return reply.code(404).send({ 
          message: 'Short URL not found or has expired',
          shortCode 
        });
      }
      
      // Return JSON with original URL (for API calls from Next.js)
      return reply.send({
        success: true,
        originalUrl: urlData.originalUrl,
        clickCount: urlData.clickCount,
      });
    } catch (error) {
      request.log.error({
        err: error,
        stack: error.stack,
        message: error.message,
      }, 'Failed to get short URL');
      
      return reply.code(500).send({
        message: 'Failed to get short URL',
        error: error.message,
      });
    }
  });
}

module.exports = shortUrlRoutes;

