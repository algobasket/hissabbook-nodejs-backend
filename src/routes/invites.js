// Invite routes (public endpoints for invite verification and acceptance)

async function invitesRoutes(app) {
  // Verify invite token (public endpoint)
  app.get('/invites/verify', {
    schema: {
      querystring: {
        type: 'object',
        required: ['token'],
        properties: {
          token: { type: 'string' },
          business: { type: 'string' },
          email: { type: 'string' },
          role: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const { token } = request.query;

      // Check if invites table exists
      const invitesTableCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'business_invites'
        );
      `);

      if (!invitesTableCheck.rows[0]?.exists) {
        // If table doesn't exist, try to find invite info from URL params
        // This is a fallback for when invites are sent but table isn't created yet
        const businessId = request.query.business;
        const email = request.query.email;
        const role = request.query.role;
        
        if (businessId) {
          // Get business info
          const businessResult = await app.pg.query(
            'SELECT id, name FROM public.businesses WHERE id = $1',
            [businessId]
          );
          
          if (businessResult.rows.length > 0) {
            const business = businessResult.rows[0];
            return reply.send({
              valid: true,
              invite: {
                token: token,
                businessId: business.id,
                businessName: business.name,
                email: email || null,
                phone: null,
                role: role || 'Staff',
                expiresAt: null,
              },
            });
          }
        }
        
        return reply.code(404).send({ message: 'Invite system not fully configured. Please contact support.' });
      }

      // Find invite by token
      const inviteResult = await app.pg.query(
        `SELECT bi.*, b.name as business_name, b.owner_user_id
         FROM public.business_invites bi
         INNER JOIN public.businesses b ON bi.business_id = b.id
         WHERE bi.invite_token = $1 AND bi.status = 'pending'`,
        [token]
      );

      if (inviteResult.rows.length === 0) {
        return reply.code(404).send({ message: 'Invite not found or already used' });
      }

      const invite = inviteResult.rows[0];

      // Check if invite has expired
      if (new Date(invite.expires_at) < new Date()) {
        return reply.code(400).send({ message: 'Invite has expired' });
      }

      return reply.send({
        valid: true,
        invite: {
          token: invite.invite_token,
          businessId: invite.business_id,
          businessName: invite.business_name,
          email: invite.email,
          phone: invite.phone,
          role: invite.role,
          expiresAt: invite.expires_at,
        },
      });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
      }, 'Failed to verify invite');
      
      return reply.code(500).send({ 
        message: 'Failed to verify invite',
        error: error.message,
      });
    }
  });

  // Accept invite (requires authentication)
  app.post('/invites/accept', {
    preValidation: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['token'],
        properties: {
          token: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const { findUserByEmail } = require('../services/userService');
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      const { token } = request.body;

      // Check if invites table exists
      const invitesTableCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'business_invites'
        );
      `);

      if (!invitesTableCheck.rows[0]?.exists) {
        return reply.code(404).send({ message: 'Invite not found' });
      }

      // Find invite by token
      const inviteResult = await app.pg.query(
        `SELECT bi.*, b.name as business_name, b.owner_user_id
         FROM public.business_invites bi
         INNER JOIN public.businesses b ON bi.business_id = b.id
         WHERE bi.invite_token = $1 AND bi.status = 'pending'`,
        [token]
      );

      if (inviteResult.rows.length === 0) {
        return reply.code(404).send({ message: 'Invite not found or already used' });
      }

      const invite = inviteResult.rows[0];

      // Check if invite has expired
      if (new Date(invite.expires_at) < new Date()) {
        return reply.code(400).send({ message: 'Invite has expired' });
      }

      // Verify email matches if invite has email
      if (invite.email && invite.email.toLowerCase() !== user.email.toLowerCase()) {
        return reply.code(403).send({ message: 'This invite is for a different email address' });
      }

      // Update invite status to accepted
      await app.pg.query(
        `UPDATE public.business_invites 
         SET status = 'accepted', accepted_at = now(), accepted_by = $1, updated_at = now()
         WHERE invite_token = $2`,
        [user.id, token]
      );

      // If role is Partner, we need to create a book for them
      // If role is Staff, they'll be added to books individually by the business owner
      // For now, we'll just mark the invite as accepted
      // The actual business membership will be handled when they're added to a book

      return reply.send({
        success: true,
        message: `You have successfully joined ${invite.business_name} as ${invite.role}`,
        invite: {
          businessId: invite.business_id,
          businessName: invite.business_name,
          role: invite.role,
        },
      });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
      }, 'Failed to accept invite');
      
      return reply.code(500).send({ 
        message: 'Failed to accept invite',
        error: error.message,
      });
    }
  });
}

module.exports = invitesRoutes;

