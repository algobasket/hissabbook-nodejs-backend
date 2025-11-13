const { findUserByEmail, createUser, getUserRoles } = require('../services/userService');
const { generateAndSaveUpiQrCode } = require('../utils/qrcode');

async function usersRoutes(app) {
  // Get admin users
  app.get('/users/admin', { preValidation: [app.authenticate] }, async (request, reply) => {
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

      const query = `
        SELECT 
          u.id,
          u.email,
          u.status,
          u.created_at,
          u.last_login_at,
          ud.first_name,
          ud.last_name,
          ud.phone,
          ud.upi_id,
          ud.upi_qr_code,
          (
            SELECT COALESCE(json_agg(
              json_build_object(
                'name', r.name,
                'description', r.description
              )
            ), '[]'::json)
            FROM public.user_roles ur
            JOIN public.roles r ON ur.role_id = r.id
            WHERE ur.user_id = u.id AND r.name = 'admin'
          ) as roles,
          uw.balance as wallet_balance,
          uw.currency_code as wallet_currency
        FROM public.users u
        LEFT JOIN public.user_details ud ON u.id = ud.user_id
        LEFT JOIN public.user_wallets uw ON u.id = uw.user_id
        WHERE EXISTS (
          SELECT 1
          FROM public.user_roles ur2
          JOIN public.roles r2 ON ur2.role_id = r2.id
          WHERE ur2.user_id = u.id 
          AND r2.name = 'admin'
        )
        ORDER BY u.created_at DESC
      `;

      const result = await app.pg.query(query);

      const admins = result.rows.map((row) => {
        const rolesArray = row.roles || [];
        const fullName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || row.email?.split('@')[0] || 'Unknown';

        return {
          id: row.id,
          email: row.email,
          firstName: row.first_name || null,
          lastName: row.last_name || null,
          fullName: fullName,
          phone: row.phone || null,
          upiId: row.upi_id || null,
          upiQrCode: row.upi_qr_code || null,
          status: row.status,
          roles: rolesArray,
          walletBalance: row.wallet_balance ? parseFloat(row.wallet_balance) : 0,
          walletCurrency: row.wallet_currency || 'INR',
          createdAt: row.created_at,
          lastLoginAt: row.last_login_at,
        };
      });

      return reply.send({ admins });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
        code: error.code,
        detail: error.detail
      }, 'Failed to fetch admin users');
      
      const errorMessage = error.detail || error.message || 'Failed to fetch admin users';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Get all users (for cashbook owner selection - includes all roles)
  app.get('/users/all', { preValidation: [app.authenticate] }, async (request, reply) => {
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

      const query = `
        SELECT 
          u.id,
          u.email,
          u.status,
          u.created_at,
          u.last_login_at,
          ud.first_name,
          ud.last_name,
          ud.phone,
          ud.upi_id,
          (
            SELECT COALESCE(json_agg(
              json_build_object(
                'name', r.name,
                'description', r.description
              ) ORDER BY r.name ASC
            ), '[]'::json)
            FROM public.user_roles ur
            JOIN public.roles r ON ur.role_id = r.id
            WHERE ur.user_id = u.id
          ) as roles
        FROM public.users u
        LEFT JOIN public.user_details ud ON u.id = ud.user_id
        ORDER BY u.created_at DESC
      `;

      const result = await app.pg.query(query);

      const users = result.rows.map((row) => {
        const rolesArray = row.roles || [];
        const primaryRole = rolesArray.length > 0 ? rolesArray[0].name : null;
        const fullName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || row.email?.split('@')[0] || 'Unknown';

        return {
          id: row.id,
          email: row.email,
          name: fullName,
          firstName: row.first_name || null,
          lastName: row.last_name || null,
          phone: row.phone || null,
          upiId: row.upi_id || null,
          status: row.status,
          roles: rolesArray.map((r) => r.name),
          primaryRole: primaryRole,
          pendingRequests: 0,
          createdAt: row.created_at,
          lastLoginAt: row.last_login_at,
        };
      });

      return reply.send({ users });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
        code: error.code,
        detail: error.detail
      }, 'Failed to fetch all users');
      
      const errorMessage = error.detail || error.message || 'Failed to fetch all users';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Get all end users (staff, agents, managers - excluding admin)
  app.get('/users', { preValidation: [app.authenticate] }, async (request, reply) => {
    try {
      const { role } = request.query;

      const params = [];

      if (role && role !== 'All') {
        // Map role names to match database values
        const roleMap = {
          'Staff': 'staff',
          'Agent': 'agents',
          'Manager': 'managers',
        };
        const dbRole = roleMap[role] || role.toLowerCase();
        params.push(dbRole);
      }

      let query;
      if (params.length > 0) {
        query = `
          SELECT 
            u.id,
            u.email,
            u.status,
            u.created_at,
            u.last_login_at,
            ud.first_name,
            ud.last_name,
            ud.phone,
            ud.upi_id,
            (
              SELECT COALESCE(json_agg(
                json_build_object(
                  'name', r.name,
                  'description', r.description
                )
              ), '[]'::json)
              FROM public.user_roles ur
              JOIN public.roles r ON ur.role_id = r.id
              WHERE ur.user_id = u.id AND r.name IN ('staff', 'agents', 'managers')
            ) as roles,
            COALESCE(
              (SELECT COUNT(*)::integer
               FROM public.payout_requests pr 
               WHERE pr.user_id = u.id AND pr.status = 'pending'),
              0
            ) as pending_requests
          FROM public.users u
          LEFT JOIN public.user_details ud ON u.id = ud.user_id
          WHERE EXISTS (
            SELECT 1
            FROM public.user_roles ur2
            JOIN public.roles r2 ON ur2.role_id = r2.id
            WHERE ur2.user_id = u.id 
            AND r2.name IN ('staff', 'agents', 'managers')
            AND r2.name = $1
          )
          ORDER BY u.created_at DESC`;
      } else {
        query = `
          SELECT 
            u.id,
            u.email,
            u.status,
            u.created_at,
            u.last_login_at,
            ud.first_name,
            ud.last_name,
            ud.phone,
            ud.upi_id,
            (
              SELECT COALESCE(json_agg(
                json_build_object(
                  'name', r.name,
                  'description', r.description
                )
              ), '[]'::json)
              FROM public.user_roles ur
              JOIN public.roles r ON ur.role_id = r.id
              WHERE ur.user_id = u.id AND r.name IN ('staff', 'agents', 'managers')
            ) as roles,
            COALESCE(
              (SELECT COUNT(*)::integer
               FROM public.payout_requests pr 
               WHERE pr.user_id = u.id AND pr.status = 'pending'),
              0
            ) as pending_requests
          FROM public.users u
          LEFT JOIN public.user_details ud ON u.id = ud.user_id
          WHERE EXISTS (
            SELECT 1
            FROM public.user_roles ur2
            JOIN public.roles r2 ON ur2.role_id = r2.id
            WHERE ur2.user_id = u.id 
            AND r2.name IN ('staff', 'agents', 'managers')
          )
          ORDER BY u.created_at DESC`;
      }

      const result = await app.pg.query(query, params.length > 0 ? params : undefined);

      const users = result.rows.map((row) => {
        // Parse JSON roles safely - handle null/undefined
        let roles = [];
        if (row.roles) {
          try {
            if (typeof row.roles === 'string') {
              roles = JSON.parse(row.roles);
            } else if (Array.isArray(row.roles)) {
              roles = row.roles;
            } else if (typeof row.roles === 'object' && row.roles !== null) {
              // If it's a single object, wrap it in an array
              roles = [row.roles];
            }
          } catch (e) {
            // If parsing fails, use empty array
            roles = [];
          }
        }
        
        // Ensure roles is an array
        if (!Array.isArray(roles)) {
          roles = [];
        }
        
        // Extract role names
        const roleNames = roles.map(r => {
          if (typeof r === 'object' && r !== null && r.name) {
            return r.name;
          }
          return typeof r === 'string' ? r : 'staff';
        });
        
        const primaryRole = roleNames[0] || 'staff';
        const fullName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || row.email.split('@')[0];

        return {
          id: row.id,
          email: row.email,
          name: fullName,
          firstName: row.first_name,
          lastName: row.last_name,
          phone: row.phone,
          upiId: row.upi_id,
          status: row.status,
          roles: roleNames,
          primaryRole: primaryRole,
          pendingRequests: parseInt(row.pending_requests || '0', 10),
          createdAt: row.created_at,
          lastLoginAt: row.last_login_at,
        };
      });

      return reply.send({ users });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
        code: error.code,
        detail: error.detail
      }, 'Failed to fetch users');
      
      const errorMessage = error.detail || error.message || 'Failed to fetch users';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Create new user (admin only)
  app.post('/users', {
    preValidation: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password', 'role'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 8 },
          firstName: { type: 'string' },
          lastName: { type: 'string' },
          phone: { type: 'string' },
          upiId: { type: 'string' },
          role: { type: 'string', enum: ['staff', 'agents', 'managers', 'auditor'] },
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

      const { email, password, firstName, lastName, phone, upiId, role } = request.body;

      // Check if email already exists
      const existing = await findUserByEmail(app.pg, email);
      if (existing) {
        return reply.code(409).send({ message: 'Email already registered' });
      }

      // Auto-generate UPI ID from phone if not provided
      let finalUpiId = upiId;
      if (!finalUpiId && phone) {
        // Extract digits from phone number
        const phoneDigits = phone.replace(/\D/g, '');
        if (phoneDigits) {
          finalUpiId = `${phoneDigits}@hissabbook`;
        }
      }

      // Create user
      const newUser = await createUser(app.pg, { email, password, firstName, lastName });

      // Generate UPI QR code if UPI ID exists
      let qrCodeFilename = null;
      if (finalUpiId) {
        const fullName = [firstName, lastName].filter(Boolean).join(' ').trim() || email.split('@')[0];
        qrCodeFilename = await generateAndSaveUpiQrCode(finalUpiId, fullName);
      }

      // Add phone, UPI ID, and QR code to user_details if provided
      if (phone || finalUpiId || qrCodeFilename) {
        await app.pg.query(
          `INSERT INTO public.user_details (user_id, first_name, last_name, phone, upi_id, upi_qr_code)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (user_id) DO UPDATE
           SET phone = COALESCE(EXCLUDED.phone, user_details.phone),
               upi_id = COALESCE(EXCLUDED.upi_id, user_details.upi_id),
               upi_qr_code = COALESCE(EXCLUDED.upi_qr_code, user_details.upi_qr_code),
               updated_at = now()`,
          [newUser.id, firstName || null, lastName || null, phone || null, finalUpiId || null, qrCodeFilename]
        );
      }

      // Create user wallet with default balance of 0
      await app.pg.query(
        `INSERT INTO public.user_wallets (user_id, balance, currency_code)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO NOTHING`,
        [newUser.id, 0, 'INR']
      );

      // Assign role
      const roleResult = await app.pg.query(
        'SELECT id FROM public.roles WHERE name = $1',
        [role]
      );

      if (roleResult.rows.length === 0) {
        return reply.code(400).send({ message: `Role '${role}' not found` });
      }

      const roleId = roleResult.rows[0].id;
      await app.pg.query(
        `INSERT INTO public.user_roles (user_id, role_id)
         VALUES ($1, $2)
         ON CONFLICT (user_id, role_id) DO NOTHING`,
        [newUser.id, roleId]
      );

      // Get user roles
      const userRoles = await getUserRoles(app.pg, newUser.id);

      return reply.code(201).send({
        success: true,
        user: {
          id: newUser.id,
          email: newUser.email,
          firstName: firstName || null,
          lastName: lastName || null,
          phone: phone || null,
          upiId: finalUpiId || null,
          status: newUser.status,
          roles: userRoles,
          createdAt: newUser.created_at,
        },
      });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
        code: error.code,
        detail: error.detail
      }, 'Failed to create user');
      
      const errorMessage = error.detail || error.message || 'Failed to create user';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Update user (admin only)
  app.patch('/users/:id', {
    preValidation: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: ['string', 'null'], minLength: 8 },
          firstName: { type: ['string', 'null'] },
          lastName: { type: ['string', 'null'] },
          phone: { type: ['string', 'null'] },
          upiId: { type: ['string', 'null'] },
          role: { type: 'string', enum: ['staff', 'agents', 'managers', 'auditor'] },
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

      const { id } = request.params;
      const { email, password, firstName, lastName, phone, upiId, role } = request.body;

      // Check if user to update exists
      const userToUpdate = await app.pg.query(
        'SELECT id, email FROM public.users WHERE id = $1',
        [id]
      );

      if (userToUpdate.rows.length === 0) {
        return reply.code(404).send({ message: 'User to update not found' });
      }

      // Check if email is being changed and if new email already exists
      if (email && email !== userToUpdate.rows[0].email) {
        const existing = await findUserByEmail(app.pg, email);
        if (existing) {
          return reply.code(409).send({ message: 'Email already registered' });
        }
      }

      const client = await app.pg.connect();
      try {
        await client.query('BEGIN');

        // Update user email if provided
        if (email) {
          await client.query(
            'UPDATE public.users SET email = $1, updated_at = now() WHERE id = $2',
            [email.toLowerCase(), id]
          );
        }

        // Update password if provided
        if (password) {
          const { hashPassword } = require('../utils/password');
          const passwordHash = await hashPassword(password);
          await client.query(
            'UPDATE public.users SET password_hash = $1, updated_at = now() WHERE id = $2',
            [passwordHash, id]
          );
        }

        // Get existing user details first
        const existingDetails = await client.query(
          'SELECT upi_id, upi_qr_code, first_name, last_name, phone FROM public.user_details WHERE user_id = $1',
          [id]
        );
        const existingUpiId = existingDetails.rows[0]?.upi_id || null;
        const existingQrCode = existingDetails.rows[0]?.upi_qr_code || null;
        const existingFirstName = existingDetails.rows[0]?.first_name || null;
        const existingLastName = existingDetails.rows[0]?.last_name || null;
        const existingPhone = existingDetails.rows[0]?.phone || null;

        // Determine final values (use provided or keep existing)
        const finalFirstName = firstName !== undefined ? (firstName || null) : existingFirstName;
        const finalLastName = lastName !== undefined ? (lastName || null) : existingLastName;
        const finalPhone = phone !== undefined ? (phone || null) : existingPhone;

        // Auto-generate UPI ID from phone if not provided but phone is provided
        let finalUpiId = upiId || null;
        if (!finalUpiId && finalPhone) {
          const phoneDigits = finalPhone.replace(/\D/g, '');
          if (phoneDigits) {
            finalUpiId = `${phoneDigits}@hissabbook`;
          }
        }
        
        // If UPI ID not provided and phone not provided, keep existing
        if (!finalUpiId) {
          finalUpiId = existingUpiId;
        }

        // Generate new QR code if UPI ID is new or changed
        let qrCodeFilename = existingQrCode;
        if (finalUpiId && finalUpiId !== existingUpiId) {
          // Get user email for display name
          const userEmailResult = await client.query('SELECT email FROM public.users WHERE id = $1', [id]);
          const userEmail = userEmailResult.rows[0]?.email;
          const fullName = [finalFirstName, finalLastName].filter(Boolean).join(' ').trim();
          const displayName = fullName || userEmail?.split('@')[0] || 'User';
          
          // Delete old QR code if exists
          if (existingQrCode) {
            const fs = require('fs/promises');
            const path = require('path');
            try {
              const uploadDir = path.join(process.cwd(), 'uploads');
              await fs.unlink(path.join(uploadDir, existingQrCode)).catch(() => {});
            } catch (e) {
              // Ignore errors when deleting old file
            }
          }
          
          // Generate new QR code
          qrCodeFilename = await generateAndSaveUpiQrCode(finalUpiId, displayName);
        } else if (finalUpiId && !existingQrCode) {
          // UPI ID exists but no QR code - generate one
          const userEmailResult = await client.query('SELECT email FROM public.users WHERE id = $1', [id]);
          const userEmail = userEmailResult.rows[0]?.email;
          const fullName = [finalFirstName, finalLastName].filter(Boolean).join(' ').trim();
          const displayName = fullName || userEmail?.split('@')[0] || 'User';
          qrCodeFilename = await generateAndSaveUpiQrCode(finalUpiId, displayName);
        }

        // Update user_details - only update fields that were provided
        await client.query(
          `INSERT INTO public.user_details (user_id, first_name, last_name, phone, upi_id, upi_qr_code)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (user_id) DO UPDATE
           SET first_name = COALESCE(EXCLUDED.first_name, user_details.first_name),
               last_name = COALESCE(EXCLUDED.last_name, user_details.last_name),
               phone = CASE WHEN EXCLUDED.phone IS NOT NULL THEN EXCLUDED.phone ELSE user_details.phone END,
               upi_id = CASE WHEN EXCLUDED.upi_id IS NOT NULL THEN EXCLUDED.upi_id ELSE user_details.upi_id END,
               upi_qr_code = CASE WHEN EXCLUDED.upi_qr_code IS NOT NULL THEN EXCLUDED.upi_qr_code ELSE user_details.upi_qr_code END,
               updated_at = now()`,
          [id, finalFirstName, finalLastName, finalPhone, finalUpiId, qrCodeFilename]
        );

        // Update role if provided
        if (role) {
          const roleResult = await client.query(
            'SELECT id FROM public.roles WHERE name = $1',
            [role]
          );

          if (roleResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return reply.code(400).send({ message: `Role '${role}' not found` });
          }

          const roleId = roleResult.rows[0].id;
          
          // Remove all existing roles for this user
          await client.query(
            'DELETE FROM public.user_roles WHERE user_id = $1',
            [id]
          );

          // Assign new role
          await client.query(
            `INSERT INTO public.user_roles (user_id, role_id)
             VALUES ($1, $2)`,
            [id, roleId]
          );
        }

        await client.query('COMMIT');

        // Get updated user data
        const updatedUserResult = await app.pg.query(
          `SELECT u.id, u.email, u.status, u.created_at, ud.first_name, ud.last_name, ud.phone, ud.upi_id, ud.upi_qr_code
           FROM public.users u
           LEFT JOIN public.user_details ud ON u.id = ud.user_id
           WHERE u.id = $1`,
          [id]
        );

        const updatedUser = updatedUserResult.rows[0];
        const userRoles = await getUserRoles(app.pg, id);

        return reply.send({
          success: true,
          user: {
            id: updatedUser.id,
            email: updatedUser.email,
            firstName: updatedUser.first_name,
            lastName: updatedUser.last_name,
            phone: updatedUser.phone,
            upiId: updatedUser.upi_id,
            upiQrCode: updatedUser.upi_qr_code,
            status: updatedUser.status,
            roles: userRoles,
            createdAt: updatedUser.created_at,
          },
        });
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          // Ignore rollback errors
        }
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
        code: error.code,
        detail: error.detail
      }, 'Failed to update user');
      
      const errorMessage = error.detail || error.message || 'Failed to update user';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Ban/Unban user (admin only) - updates status to 'inactive' or 'active'
  app.patch('/users/:id/ban', {
    preValidation: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['banned'],
        properties: {
          banned: { type: 'boolean' },
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

      const { id } = request.params;
      const { banned } = request.body;

      // Check if user exists
      const userToBan = await app.pg.query(
        'SELECT id, email, status FROM public.users WHERE id = $1',
        [id]
      );

      if (userToBan.rows.length === 0) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Prevent banning admin users
      const userRoles = await getUserRoles(app.pg, id);
      if (userRoles.includes('admin')) {
        return reply.code(403).send({ message: 'Cannot ban admin users' });
      }

      // Update user status
      const newStatus = banned ? 'inactive' : 'active';
      await app.pg.query(
        'UPDATE public.users SET status = $1, updated_at = now() WHERE id = $2',
        [newStatus, id]
      );

      return reply.send({
        success: true,
        message: banned ? 'User banned successfully' : 'User unbanned successfully',
        status: newStatus,
      });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
        code: error.code,
        detail: error.detail
      }, 'Failed to ban/unban user');
      
      const errorMessage = error.detail || error.message || 'Failed to ban/unban user';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Delete user (admin only) - deletes user and all related records via cascade
  app.delete('/users/:id', {
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

      const { id } = request.params;

      // Check if user exists
      const userToDelete = await app.pg.query(
        'SELECT id, email FROM public.users WHERE id = $1',
        [id]
      );

      if (userToDelete.rows.length === 0) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Prevent deleting admin users
      const userRoles = await getUserRoles(app.pg, id);
      if (userRoles.includes('admin')) {
        return reply.code(403).send({ message: 'Cannot delete admin users' });
      }

      // Prevent deleting yourself
      if (id === user.id) {
        return reply.code(403).send({ message: 'Cannot delete your own account' });
      }

      // Get user details to delete QR code file if exists
      const userDetails = await app.pg.query(
        'SELECT upi_qr_code FROM public.user_details WHERE user_id = $1',
        [id]
      );

      // Delete QR code file if it exists
      if (userDetails.rows[0]?.upi_qr_code) {
        try {
          const fs = require('fs').promises;
          const path = require('path');
          const uploadDir = path.join(process.cwd(), 'uploads');
          const qrCodePath = path.join(uploadDir, userDetails.rows[0].upi_qr_code);
          await fs.unlink(qrCodePath).catch(() => {
            // File doesn't exist or can't be deleted - that's okay
          });
        } catch (qrError) {
          request.log.warn({ err: qrError }, 'Failed to delete user QR code file');
        }
      }

      // Delete user (cascade will handle related records: user_details, user_roles, user_wallets, transactions, etc.)
      const deleteResult = await app.pg.query('DELETE FROM public.users WHERE id = $1', [id]);

      if (deleteResult.rowCount === 0) {
        return reply.code(404).send({ message: 'User not found or already deleted' });
      }

      return reply.send({
        success: true,
        message: 'User deleted successfully. All related records have been removed.',
      });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
        code: error.code,
        detail: error.detail
      }, 'Failed to delete user');
      
      const errorMessage = error.detail || error.message || 'Failed to delete user';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });
}

module.exports = usersRoutes;

