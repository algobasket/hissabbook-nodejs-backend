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

  // Get invites for the currently authenticated user (staff/managers)
  app.get('/invites/my', {
    preValidation: [app.authenticate],
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Check if required tables exist
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
          bi.accepted_by,
          bi.cashbook_id
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

      // Filter invites that belong to this user:
      // - If user_invites table exists: they accepted the invite (ui.user_id = user.id)
      // - Or the invite email matches their account email
      let params;
      if (hasUserInvitesTable) {
        query += `
          WHERE (
            (ui.user_id = $1)
            OR (bi.email IS NOT NULL AND bi.email = $2)
          )
          ORDER BY bi.created_at DESC
        `;
        params = [user.id, user.email];
      } else {
        query += `
          WHERE (bi.email IS NOT NULL AND bi.email = $1)
          ORDER BY bi.created_at DESC
        `;
        params = [user.email];
      }

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
        cashbookId: invite.cashbook_id,
      }));

      return reply.send({ invites });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
      }, 'Failed to fetch invites for current user');
      
      return reply.code(500).send({ 
        message: 'Failed to fetch invites for current user',
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

      // Find invite by token (allow both pending and accepted invites)
      // Explicitly select cashbook_id to ensure it's included even if column was added later
      const inviteResult = await app.pg.query(
        `SELECT bi.*, b.name as business_name, b.owner_user_id, bi.cashbook_id
         FROM public.business_invites bi
         INNER JOIN public.businesses b ON bi.business_id = b.id
         WHERE bi.invite_token = $1 AND bi.status IN ('pending', 'accepted')`,
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

      // Update invite status to accepted (only if it's still pending)
      await app.pg.query(
        `UPDATE public.business_invites 
         SET status = 'accepted', accepted_at = COALESCE(accepted_at, now()), accepted_by = COALESCE(accepted_by, $1), updated_at = now()
         WHERE invite_token = $2 AND status = 'pending'`,
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

      // If role is Staff and there's a cashbookId (from request body or stored in invite), add user to that book
      const { cashbookId: cashbookIdFromRequest } = request.body;
      // Use cashbookId from request body if provided, otherwise use the one stored in the invite
      const cashbookId = cashbookIdFromRequest || invite.cashbook_id;
      
      request.log.info({
        role: invite.role,
        cashbookIdFromRequest,
        cashbookIdFromInvite: invite.cashbook_id,
        finalCashbookId: cashbookId,
        inviteId: invite.id,
        userId: user.id,
        requestBody: request.body
      }, 'Processing invite acceptance for Staff role');
      
      if (invite.role === 'Staff' && cashbookId) {
        try {
          // Check if book_users table exists
          const bookUsersTableCheck = await app.pg.query(`
            SELECT EXISTS (
              SELECT FROM information_schema.tables 
              WHERE table_schema = 'public' 
              AND table_name = 'book_users'
            );
          `);

          if (!bookUsersTableCheck.rows[0]?.exists) {
            request.log.error('book_users table does not exist - cannot add user to book');
            throw new Error('book_users table does not exist. Please run database migration.');
          }

          // Check if book exists
          const bookCheck = await app.pg.query(
            'SELECT id, business_id, name FROM public.books WHERE id = $1',
            [cashbookId]
          );

          if (bookCheck.rows.length === 0) {
            request.log.error({ cashbookId }, 'Book not found when trying to add user after invite acceptance');
            throw new Error(`Cashbook with ID ${cashbookId} not found`);
          }

          const book = bookCheck.rows[0];
          request.log.info({
            bookId: cashbookId,
            bookName: book.name,
            bookBusinessId: book.business_id,
            inviteBusinessId: invite.business_id,
            cashbookIdFromRequest,
            cashbookIdFromInvite: invite.cashbook_id,
            finalCashbookId: cashbookId
          }, 'Adding user to book after accepting Staff invite');
          
          // For Staff invites with cashbookId, always add user to the book
          // The cashbookId being present means the manager explicitly selected this book
          // We trust the cashbookId regardless of business_id matching
          const result = await app.pg.query(
            `INSERT INTO public.book_users (book_id, user_id, added_by)
             VALUES ($1, $2, $3)
             ON CONFLICT (book_id, user_id) DO NOTHING
             RETURNING id`,
            [cashbookId, user.id, invite.invited_by || user.id]
          );
          
          if (result.rows.length > 0) {
            request.log.info({ 
              bookId: cashbookId, 
              userId: user.id,
              addedBy: invite.invited_by || user.id,
              bookUserId: result.rows[0].id
            }, 'User successfully added to book after accepting invite');
            
            // Verify the insertion by querying again
            const verifyCheck = await app.pg.query(
              'SELECT id, book_id, user_id, added_at FROM public.book_users WHERE book_id = $1 AND user_id = $2',
              [cashbookId, user.id]
            );
            if (verifyCheck.rows.length > 0) {
              request.log.info({ 
                verified: true,
                bookUserId: verifyCheck.rows[0].id,
                addedAt: verifyCheck.rows[0].added_at
              }, 'Verified: User is now in book_users table');
            } else {
              request.log.error({ 
                bookId: cashbookId, 
                userId: user.id
              }, 'CRITICAL: User was not found in book_users after insertion');
            }
          } else {
            // Check if user already exists (might have been added by ON CONFLICT)
            const existingCheck = await app.pg.query(
              'SELECT id, added_at FROM public.book_users WHERE book_id = $1 AND user_id = $2',
              [cashbookId, user.id]
            );
            if (existingCheck.rows.length > 0) {
              request.log.info({ 
                bookId: cashbookId, 
                userId: user.id,
                existingBookUserId: existingCheck.rows[0].id,
                addedAt: existingCheck.rows[0].added_at
              }, 'User already exists in book (was not inserted due to conflict)');
            } else {
              request.log.error({ 
                bookId: cashbookId, 
                userId: user.id
              }, 'CRITICAL: Failed to add user to book - no rows returned and user not found in book_users');
            }
          }
        } catch (bookError) {
          // Log error but don't fail the invite acceptance (user can still accept invite)
          // However, log it as a warning so it's visible
          request.log.error({ 
            err: bookError, 
            cashbookId,
            userId: user.id,
            errorMessage: bookError.message,
            errorStack: bookError.stack
          }, 'Error adding user to book after invite acceptance - invite will still be marked as accepted');
        }
      }

      // Update user's system role based on invite role
      // "Staff" from invite -> "staff" in system
      // "Partner" from invite -> "managers" in system (partners are managers)
      if (invite.role === 'Staff' || invite.role === 'Partner') {
        try {
          let systemRole = 'managers'; // Default
          if (invite.role === 'Staff') {
            systemRole = 'staff';
          } else if (invite.role === 'Partner') {
            systemRole = 'managers'; // Partners are managers in the system
          }

          // Get role ID
          const roleResult = await app.pg.query(
            'SELECT id FROM public.roles WHERE name = $1',
            [systemRole]
          );

          if (roleResult.rows.length > 0) {
            const roleId = roleResult.rows[0].id;
            
            // Remove all existing roles for this user (to ensure they only have the invite role)
            await app.pg.query(
              'DELETE FROM public.user_roles WHERE user_id = $1',
              [user.id]
            );

            // Assign the role from invite
            await app.pg.query(
              `INSERT INTO public.user_roles (user_id, role_id)
               VALUES ($1, $2)
               ON CONFLICT (user_id, role_id) DO NOTHING`,
              [user.id, roleId]
            );

            request.log.info({
              userId: user.id,
              inviteRole: invite.role,
              systemRole: systemRole,
              roleId: roleId
            }, 'Updated user system role based on invite acceptance');
          } else {
            request.log.warn({
              systemRole: systemRole,
              inviteRole: invite.role
            }, 'Role not found when trying to update user role from invite');
          }
        } catch (roleError) {
          // Log error but don't fail the invite acceptance
          request.log.error({ 
            err: roleError, 
            userId: user.id,
            inviteRole: invite.role
          }, 'Error updating user role from invite acceptance');
        }
      }

      // Get updated user roles after role assignment
      const updatedRoles = await getUserRoles(app.pg, user.id);
      const primaryRole = updatedRoles[0] || 'managers';

      // Generate new token with updated role (if JWT is available)
      let newToken = null;
      if (app.jwt) {
        try {
          newToken = app.jwt.sign({
            sub: user.id,
            email: user.email,
            status: user.status,
            roles: updatedRoles,
            role: primaryRole,
          });
        } catch (tokenError) {
          request.log.warn({ err: tokenError }, 'Failed to generate new token after role update');
        }
      }

      // If role is Partner, we need to create a book for them
      // If role is Staff, they'll be added to books individually by the business owner
      // For now, we'll just mark the invite as accepted
      // The actual business membership will be handled when they're added to a book

      return reply.send({
        success: true,
        message: `You have successfully joined ${invite.business_name} as ${invite.role}`,
        token: newToken, // New token with updated role
        user: newToken ? {
          id: user.id,
          email: user.email,
          status: user.status,
          roles: updatedRoles,
          role: primaryRole,
        } : undefined,
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



