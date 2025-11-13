/* eslint-disable no-console */
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const dotenv = require('dotenv');
const path = require('path');
const { hashPassword } = require('./src/utils/password');

dotenv.config({
  path: path.resolve(__dirname, '.env'),
});

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is not set. Please define it in hissabbook-nodejs-backend/.env');
  process.exit(1);
}

async function seedAdminUser() {
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const adminEmail = 'admin@hissabbook.in';
    const adminPassword = 'admin@123';

    // Check if admin user already exists
    const existingUser = await client.query(
      'SELECT id FROM public.users WHERE email = $1',
      [adminEmail.toLowerCase()]
    );

    if (existingUser.rows.length > 0) {
      console.log('Admin user already exists. Updating password...');
      const userId = existingUser.rows[0].id;
      const passwordHash = await hashPassword(adminPassword);
      
      await client.query(
        'UPDATE public.users SET password_hash = $1, updated_at = now() WHERE id = $2',
        [passwordHash, userId]
      );

      // Ensure admin role is assigned
      const roleResult = await client.query(
        'SELECT id FROM public.roles WHERE name = $1',
        ['admin']
      );

      if (roleResult.rows.length > 0) {
        const roleId = roleResult.rows[0].id;
        await client.query(
          `INSERT INTO public.user_roles (user_id, role_id)
           VALUES ($1, $2)
           ON CONFLICT (user_id, role_id) DO NOTHING`,
          [userId, roleId]
        );
        console.log('✔ Admin role assigned');
      } else {
        console.warn('⚠ Admin role not found. Please run migrations first.');
      }

      await client.query('COMMIT');
      console.log('✔ Admin user password updated successfully');
      return;
    }

    // Create new admin user
    console.log('Creating admin user...');
    const userId = uuidv4();
    const passwordHash = await hashPassword(adminPassword);

    await client.query(
      `INSERT INTO public.users (id, email, password_hash, status)
       VALUES ($1, $2, $3, 'active')
       RETURNING id, email, status`,
      [userId, adminEmail.toLowerCase(), passwordHash]
    );

    console.log('✔ Admin user created');

    // Get admin role ID
    const roleResult = await client.query(
      'SELECT id FROM public.roles WHERE name = $1',
      ['admin']
    );

    if (roleResult.rows.length === 0) {
      throw new Error('Admin role not found. Please run migrations (007_seed_roles.sql) first.');
    }

    const roleId = roleResult.rows[0].id;

    // Assign admin role
    await client.query(
      `INSERT INTO public.user_roles (user_id, role_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, role_id) DO NOTHING`,
      [userId, roleId]
    );

    console.log('✔ Admin role assigned');

    await client.query('COMMIT');
    console.log('✔ Admin user seeded successfully!');
    console.log(`   Email: ${adminEmail}`);
    console.log(`   Password: ${adminPassword}`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('✖ Failed to seed admin user:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

seedAdminUser().catch((error) => {
  console.error(error);
  process.exit(1);
});

