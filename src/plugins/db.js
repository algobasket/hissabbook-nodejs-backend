const fp = require('fastify-plugin');
const { Pool } = require('pg');

async function dbPlugin(fastifyInstance) {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set');
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });

  fastifyInstance.decorate('pg', pool);

  fastifyInstance.addHook('onClose', async () => {
    await pool.end();
  });
}

module.exports = fp(dbPlugin);

