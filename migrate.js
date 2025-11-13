/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config({
  path: path.resolve(__dirname, '.env'),
});

const migrationsDir = path.resolve(__dirname, '..', 'data', 'migrations');
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is not set. Please define it in hissabbook-nodejs-backend/.env');
  process.exit(1);
}

async function loadMigrationFiles() {
  const entries = await fs.promises.readdir(migrationsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
}

async function runMigrations() {
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: {
      rejectUnauthorized: false,
    },
  });

  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        filename text PRIMARY KEY,
        executed_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    const files = await loadMigrationFiles();

    for (const file of files) {
      const alreadyRun = await client.query('SELECT 1 FROM public.schema_migrations WHERE filename = $1', [file]);

      if (alreadyRun.rowCount > 0) {
        console.log('Skipping ' + file + ' (already applied)');
        continue;
      }

      const filePath = path.join(migrationsDir, file);
      const sql = await fs.promises.readFile(filePath, 'utf8');

      console.log('Applying migration ' + file + '...');

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO public.schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log('✔ Migration ' + file + ' applied');
      } catch (error) {
        await client.query('ROLLBACK');
        console.error('✖ Migration ' + file + ' failed');
        throw error;
      }
    }

    console.log('All migrations applied');
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations().catch((error) => {
  console.error(error);
  process.exit(1);
});

