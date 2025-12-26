const fastify = require('fastify');
const cors = require('@fastify/cors');
const jwt = require('@fastify/jwt');
const fs = require('fs/promises');
const path = require('path');
const registerDatabase = require('./plugins/db');
const authRoutes = require('./routes/auth');
const payoutRequestRoutes = require('./routes/payoutRequests');
const rolesRoutes = require('./routes/roles');
const usersRoutes = require('./routes/users');
const walletsRoutes = require('./routes/wallets');
const transactionsRoutes = require('./routes/transactions');
const booksRoutes = require('./routes/books');
const dashboardRoutes = require('./routes/dashboard');
const businessesRoutes = require('./routes/businesses');
const permissionsRoutes = require('./routes/permissions');
const invitesRoutes = require('./routes/invites');
const subscriptionsRoutes = require('./routes/subscriptions');

async function buildApp() {
  const app = fastify({
    logger: true,
    bodyLimit: 50 * 1024 * 1024, // 50MB limit for large image uploads
  }); 

  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not set');
  }

  await app.register(jwt, {
    secret: process.env.JWT_SECRET,
    sign: {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d', // Changed from 1h to 7 days
    },
  });

  await app.register(registerDatabase);

  app.decorate('authenticate', async function authenticate(request, reply) {
    try {
      await request.jwtVerify();
    } catch (error) {
      reply.code(401).send({ message: 'Unauthorized', error: error.message });
    }
  });

  app.get('/health', async () => ({ status: 'ok' }));

  // Serve uploaded files
  app.get('/uploads/:filename', async (request, reply) => {
    const { filename } = request.params;

    // Security: prevent directory traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return reply.code(400).send({ message: 'Invalid filename' });
    }

    try {
      // Try current directory first (hissabbook-nodejs-backend/uploads)
      let filePath = path.join(process.cwd(), 'uploads', filename);
      let fileBuffer;
      
      request.log.info({
        filename,
        filePath,
        cwd: process.cwd(),
        requestUrl: request.url
      }, 'Attempting to serve uploaded file');
      
      try {
        fileBuffer = await fs.readFile(filePath);
        request.log.info({ filename, filePath, size: fileBuffer.length }, 'File found and read successfully');
      } catch (error) {
        // If not found, try the api-system uploads directory
        if (error.code === 'ENOENT') {
          const apiSystemPath = path.join(process.cwd(), '..', 'hissabbook-api-system', 'uploads', filename);
          request.log.info({ filename, tryingPath: apiSystemPath }, 'File not found in primary location, trying api-system directory');
          try {
            fileBuffer = await fs.readFile(apiSystemPath);
            request.log.info({ filename, path: apiSystemPath }, 'Serving file from api-system directory');
          } catch (apiSystemError) {
            // If still not found, return 404
            if (apiSystemError.code === 'ENOENT') {
              request.log.warn({ 
                filename, 
                triedPaths: [filePath, apiSystemPath],
                cwd: process.cwd(),
                error: apiSystemError.message
              }, 'File not found in any uploads directory');
              return reply.code(404).send({ message: 'File not found', filename, triedPaths: [filePath, apiSystemPath] });
            }
            throw apiSystemError;
          }
        } else {
          request.log.error({ filename, filePath, error: error.message }, 'Error reading file');
          throw error;
        }
      }

      // Determine content type based on file extension
      const ext = path.extname(filename).toLowerCase();
      const contentTypeMap = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.pdf': 'application/pdf',
        '.apk': 'application/vnd.android.package-archive',
      };
      const contentType = contentTypeMap[ext] || 'application/octet-stream';

      reply.type(contentType);
      return reply.send(fileBuffer);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return reply.code(404).send({ message: 'File not found' });
      }
      request.log.error({ err: error }, 'Failed to serve file');
      return reply.code(500).send({ message: 'Failed to serve file' });
    }
  });

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(payoutRequestRoutes, { prefix: '/api/payout-requests' });
  await app.register(rolesRoutes, { prefix: '/api' });
  await app.register(usersRoutes, { prefix: '/api' });
  await app.register(walletsRoutes, { prefix: '/api' });
  await app.register(transactionsRoutes, { prefix: '/api' });
  await app.register(booksRoutes, { prefix: '/api' });
  await app.register(dashboardRoutes, { prefix: '/api' });
  await app.register(businessesRoutes, { prefix: '/api' });
  await app.register(permissionsRoutes, { prefix: '/api' });
  await app.register(invitesRoutes, { prefix: '/api' });
  await app.register(require('./routes/settings'), { prefix: '/api' });
  await app.register(subscriptionsRoutes, { prefix: '/api' });
  await app.register(require('./routes/shortUrl'), { prefix: '/api' }); // Register with /api prefix so frontend can call it

  return app;
}

module.exports = buildApp;

