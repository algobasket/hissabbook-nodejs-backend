// Permissions Routes for managing role permissions

const { findUserByEmail, getUserRoles } = require('../services/userService');

async function permissionsRoutes(app) {
  // Get all permissions
  app.get('/permissions', {
    preValidation: [app.authenticate],
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Check if user is admin
      const roles = await getUserRoles(app.pg, user.id);
      const isAdmin = roles.includes('admin');

      if (!isAdmin) {
        return reply.code(403).send({ message: 'Access denied. Admin role required.' });
      }

      const result = await app.pg.query(
        `SELECT 
          id,
          name,
          code,
          description,
          category,
          created_at,
          updated_at
        FROM public.permissions
        ORDER BY category, name ASC`
      );

      return reply.send({
        permissions: result.rows.map((row) => ({
          id: row.id,
          name: row.name,
          code: row.code,
          description: row.description,
          category: row.category,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
      });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to fetch permissions');
      return reply.code(500).send({ 
        message: 'Failed to fetch permissions', 
        error: error.message 
      });
    }
  });

  // Get permissions for a specific role
  app.get('/roles/:roleId/permissions', {
    preValidation: [app.authenticate],
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Check if user is admin
      const roles = await getUserRoles(app.pg, user.id);
      const isAdmin = roles.includes('admin');

      if (!isAdmin) {
        return reply.code(403).send({ message: 'Access denied. Admin role required.' });
      }

      const { roleId } = request.params;

      const result = await app.pg.query(
        `SELECT 
          p.id,
          p.name,
          p.code,
          p.description,
          p.category,
          CASE WHEN rp.role_id IS NOT NULL THEN true ELSE false END as granted
        FROM public.permissions p
        LEFT JOIN public.role_permissions rp ON p.id = rp.permission_id AND rp.role_id = $1
        ORDER BY p.category, p.name ASC`,
        [roleId]
      );

      return reply.send({
        permissions: result.rows.map((row) => ({
          id: row.id,
          name: row.name,
          code: row.code,
          description: row.description,
          category: row.category,
          granted: row.granted,
        })),
      });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to fetch role permissions');
      return reply.code(500).send({ 
        message: 'Failed to fetch role permissions', 
        error: error.message 
      });
    }
  });

  // Update permissions for a role
  app.put('/roles/:roleId/permissions', {
    preValidation: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['permissionIds'],
        properties: {
          permissionIds: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Check if user is admin
      const roles = await getUserRoles(app.pg, user.id);
      const isAdmin = roles.includes('admin');

      if (!isAdmin) {
        return reply.code(403).send({ message: 'Access denied. Admin role required.' });
      }

      const { roleId } = request.params;
      const { permissionIds } = request.body;

      // Verify role exists
      const roleCheck = await app.pg.query('SELECT id FROM public.roles WHERE id = $1', [roleId]);
      if (roleCheck.rows.length === 0) {
        return reply.code(404).send({ message: 'Role not found' });
      }

      // Start transaction
      await app.pg.query('BEGIN');

      try {
        // Remove all existing permissions for this role
        await app.pg.query('DELETE FROM public.role_permissions WHERE role_id = $1', [roleId]);

        // Add new permissions
        if (permissionIds && permissionIds.length > 0) {
          for (const permId of permissionIds) {
            await app.pg.query(
              `INSERT INTO public.role_permissions (role_id, permission_id)
               VALUES ($1, $2)
               ON CONFLICT DO NOTHING`,
              [roleId, permId]
            );
          }
        }

        await app.pg.query('COMMIT');

        return reply.send({
          success: true,
          message: 'Permissions updated successfully',
        });
      } catch (error) {
        await app.pg.query('ROLLBACK');
        throw error;
      }
    } catch (error) {
      request.log.error({ err: error }, 'Failed to update role permissions');
      return reply.code(500).send({ 
        message: 'Failed to update role permissions', 
        error: error.message 
      });
    }
  });
}

module.exports = permissionsRoutes;

