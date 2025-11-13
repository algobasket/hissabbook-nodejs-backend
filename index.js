require('dotenv').config();

const buildApp = require('./src/app');

const port = process.env.PORT || 5000;
const host = process.env.HOST || '0.0.0.0';

async function start() {
  const app = await buildApp();

  try {
    await app.listen({ port, host });
    // eslint-disable-next-line no-console
    console.log(`Server listening on http://${host}:${port}`);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to start Fastify server', error);
    process.exit(1);
  }
}

start();


