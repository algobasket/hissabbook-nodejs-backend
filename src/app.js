const fastify = require('fastify');
const cors = require('@fastify/cors');
const jwt = require('@fastify/jwt');
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

async function buildApp() {
  const app = fastify({
    logger: true,
  });

  await app.register(cors, {
    origin: true,
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

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(payoutRequestRoutes, { prefix: '/api/payout-requests' });
  await app.register(rolesRoutes, { prefix: '/api' });
  await app.register(usersRoutes, { prefix: '/api' });
  await app.register(walletsRoutes, { prefix: '/api' });
  await app.register(transactionsRoutes, { prefix: '/api' });
  await app.register(booksRoutes, { prefix: '/api' });
  await app.register(dashboardRoutes, { prefix: '/api' });
  await app.register(businessesRoutes, { prefix: '/api' });

  return app;
}

module.exports = buildApp;

