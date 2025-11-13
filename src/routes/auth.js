const { verifyPassword } = require('../utils/password');
const { findUserByEmail, createUser, getUserRoles } = require('../services/userService');

async function authRoutes(app) {
  app.post('/register', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 8 },
          firstName: { type: 'string', minLength: 1 },
          lastName: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { email, password, firstName, lastName } = request.body;
    const existing = await findUserByEmail(app.pg, email);

    if (existing) {
      return reply.code(409).send({ message: 'Email already registered' });
    }

    const user = await createUser(app.pg, { email, password, firstName, lastName });

    return reply.code(201).send({
      user: {
        id: user.id,
        email: user.email,
        status: user.status,
        createdAt: user.created_at,
      },
    });
  });

  app.post('/login', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { email, password } = request.body;

    const user = await findUserByEmail(app.pg, email);

    if (!user) {
      return reply.code(401).send({ message: 'Invalid email or password' });
    }

    const isValid = await verifyPassword(password, user.password_hash);

    if (!isValid) {
      return reply.code(401).send({ message: 'Invalid email or password' });
    }

    await app.pg.query(
      'UPDATE public.users SET last_login_at = now(), updated_at = now() WHERE id = $1',
      [user.id],
    );

    // Get user roles
    const roles = await getUserRoles(app.pg, user.id);
    const primaryRole = roles[0] || null;

    const token = app.jwt.sign({
      sub: user.id,
      email: user.email,
      status: user.status,
      roles: roles,
      role: primaryRole,
    });

    return reply.send({
      token,
      user: {
        id: user.id,
        email: user.email,
        status: user.status,
        roles: roles,
        role: primaryRole,
      },
    });
  });

  app.post('/logout', { preValidation: [app.authenticate] }, async (request, reply) => {
    // For stateless JWT auth we simply rely on client to discard token.
    return reply.send({ success: true });
  });

  app.get('/me', { preValidation: [app.authenticate] }, async (request) => {
    const user = await findUserByEmail(app.pg, request.user.email);
    const roles = await getUserRoles(app.pg, user.id);
    const primaryRole = roles[0] || null;

    return {
      user: {
        id: user.id,
        email: user.email,
        status: user.status,
        roles: roles,
        role: primaryRole,
        createdAt: user.created_at,
        lastLoginAt: user.last_login_at,
      },
    };
  });
}

module.exports = authRoutes;

