async function rolesRoutes(app) {
  // Get all roles
  app.get('/roles', { preValidation: [app.authenticate] }, async (request, reply) => {
    try {
      const result = await app.pg.query(
        `SELECT 
          r.id,
          r.name,
          r.description,
          r.created_at,
          r.updated_at,
          COUNT(ur.user_id) as user_count
        FROM public.roles r
        LEFT JOIN public.user_roles ur ON r.id = ur.role_id
        GROUP BY r.id, r.name, r.description, r.created_at, r.updated_at
        ORDER BY r.name ASC`
      );

      return reply.send({
        roles: result.rows.map((row) => ({
          id: row.id,
          name: row.name,
          description: row.description,
          userCount: parseInt(row.user_count, 10),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
      });
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ message: 'Failed to fetch roles', error: error.message });
    }
  });

  // Get roles permissions matrix
  app.get('/roles-permissions', { preValidation: [app.authenticate] }, async (request, reply) => {
    try {
      // Define the permissions matrix based on the design
      const permissionsMatrix = [
        {
          capability: 'Create payout request',
          endUser: '✔',
          businessOwner: '✔',
          auditor: 'View',
          platformAdmin: '✔',
        },
        {
          capability: 'Upload attachments',
          endUser: '✔',
          businessOwner: '✔',
          auditor: 'View',
          platformAdmin: '✔',
        },
        {
          capability: 'Approve / Reject payout',
          endUser: '—',
          businessOwner: '✔',
          auditor: 'View',
          platformAdmin: '✔',
        },
        {
          capability: 'Automatically post to ledger on Accept',
          endUser: 'Auto',
          businessOwner: 'Triggered',
          auditor: 'Verify',
          platformAdmin: 'Override if needed',
        },
        {
          capability: 'Initiate reversal',
          endUser: '—',
          businessOwner: 'Request escalation',
          auditor: 'View',
          platformAdmin: '✔ (dual approval)',
        },
        {
          capability: 'Access audit log',
          endUser: 'History of own requests',
          businessOwner: 'Full history',
          auditor: 'Full history + export',
          platformAdmin: 'Full history',
        },
        {
          capability: 'Manage role assignments',
          endUser: '—',
          businessOwner: 'Suggest changes',
          auditor: '—',
          platformAdmin: '✔',
        },
      ];

      return reply.send({
        permissionsMatrix,
        notes: [
          'Ledger entries are immutable once posted; reversals create a new journal line with reference to the original request.',
          'Auditor comments trigger notifications but cannot block payouts.',
          'Multi-factor authentication is enforced for Business Owners, Auditors, and Platform Admins.',
        ],
      });
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ message: 'Failed to fetch permissions matrix', error: error.message });
    }
  });
}

module.exports = rolesRoutes;

