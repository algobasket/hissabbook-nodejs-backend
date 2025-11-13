const { v4: uuidv4 } = require('uuid');
const { hashPassword } = require('../utils/password');

async function findUserByEmail(pool, email) {
  const result = await pool.query('SELECT * FROM public.users WHERE email = $1 LIMIT 1', [email.toLowerCase()]);
  return result.rows[0];
}

async function getUserRoles(pool, userId) {
  const result = await pool.query(
    `SELECT r.name 
     FROM public.user_roles ur
     JOIN public.roles r ON ur.role_id = r.id
     WHERE ur.user_id = $1`,
    [userId],
  );
  return result.rows.map((row) => row.name);
}

async function createUser(pool, { email, password, firstName, lastName }) {
  const id = uuidv4();
  const passwordHash = await hashPassword(password);

  const result = await pool.query(
    `INSERT INTO public.users (id, email, password_hash)
     VALUES ($1, $2, $3)
     RETURNING id, email, status, created_at, updated_at`,
    [id, email.toLowerCase(), passwordHash],
  );

  const user = result.rows[0];

  await pool.query(
    `INSERT INTO public.user_details (user_id, first_name, last_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO NOTHING`,
    [user.id, firstName || null, lastName || null],
  );

  return user;
}

module.exports = {
  findUserByEmail,
  createUser,
  getUserRoles,
};

