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

async function buildApp() {
  const app = fastify({
    logger: true,
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
      expiresIn: process.env.JWT_EXPIRES_IN || '1h',
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
      const filePath = path.join(process.cwd(), 'uploads', filename);
      const fileBuffer = await fs.readFile(filePath);

      // Determine content type based on file extension
      const ext = path.extname(filename).toLowerCase();
      const contentTypeMap = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.pdf': 'application/pdf',
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

  return app;
}

module.exports = buildApp;

