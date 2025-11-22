// Invite routes (public endpoints for invite verification and acceptance)

const { findUserByEmail, getUserRoles } = require('../services/userService');

async function invitesRoutes(app) {
  // Get all invites (admin only)
  app.get('/invites', {
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

      // Check if invites table exists
      const invitesTableCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'business_invites'
        );
      `);

      if (!invitesTableCheck.rows[0]?.exists) {
        return reply.send({ invites: [] });
      }

      const { status } = request.query;
      
      // Check if user_invites table exists
      const userInvitesTableCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'user_invites'
        );
      `);

      const hasUserInvitesTable = userInvitesTableCheck.rows[0]?.exists;

      let query = `
        SELECT 
          bi.id,
          bi.business_id,
          b.name as business_name,
          bi.email,
          bi.phone,
          bi.role,
          bi.invite_token,
          bi.status,
          bi.invited_by,
          inviter.email as inviter_email,
          bi.expires_at,
          bi.created_at,
          bi.updated_at,
          bi.accepted_at,
          bi.accepted_by
      `;

      if (hasUserInvitesTable) {
        query += `,
          ui.user_id as accepted_user_id,
          ui.status as user_invite_status,
          ui.accepted_at as user_accepted_at,
          u.email as accepted_user_email
        `;
      } else {
        query += `,
          NULL::uuid as accepted_user_id,
          NULL::text as user_invite_status,
          NULL::timestamptz as user_accepted_at,
          NULL::text as accepted_user_email
        `;
      }

      query += `
        FROM public.business_invites bi
        INNER JOIN public.businesses b ON bi.business_id = b.id
        LEFT JOIN public.users inviter ON bi.invited_by = inviter.id
      `;

      if (hasUserInvitesTable) {
        query += `
          LEFT JOIN public.user_invites ui ON bi.id = ui.business_invite_id
          LEFT JOIN public.users u ON ui.user_id = u.id
        `;
      }

      const params = [];
      if (status && status !== 'all') {
        query += ' WHERE bi.status = $1';
        params.push(status);
      }

      query += ' ORDER BY bi.created_at DESC';

      const result = await app.pg.query(query, params);

      const invites = result.rows.map((invite) => ({
        id: invite.id,
        businessId: invite.business_id,
        businessName: invite.business_name,
        email: invite.email,
        phone: invite.phone,
        role: invite.role,
        inviteToken: invite.invite_token,
        status: invite.status,
        invitedBy: invite.invited_by,
        inviterEmail: invite.inviter_email,
        expiresAt: invite.expires_at,
        createdAt: invite.created_at,
        updatedAt: invite.updated_at,
        acceptedAt: invite.accepted_at || invite.user_accepted_at,
        acceptedBy: invite.accepted_by || invite.accepted_user_id,
        acceptedUserEmail: invite.accepted_user_email,
        userInviteStatus: invite.user_invite_status,
      }));

      return reply.send({ invites });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
      }, 'Failed to fetch invites');
      
      return reply.code(500).send({ 
        message: 'Failed to fetch invites',
        error: error.message,
      });
    }
  });
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

      // Create user_invites record to track acceptance
      // Check if user_invites table exists
      const userInvitesTableCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'user_invites'
        );
      `);

      if (userInvitesTableCheck.rows[0]?.exists) {
        // Insert or update user_invites record
        await app.pg.query(
          `INSERT INTO public.user_invites (user_id, business_invite_id, business_id, role, status, accepted_at)
           VALUES ($1, $2, $3, $4, 'active', now())
           ON CONFLICT (user_id, business_invite_id) 
           DO UPDATE SET status = 'active', updated_at = now()`,
          [user.id, invite.id, invite.business_id, invite.role]
        );
      }

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



