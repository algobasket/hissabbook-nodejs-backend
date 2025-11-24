// Payout Requests Routes for Admin Panel
// This is used by hissabbook-react-admin (NOT hissabbook-api-system)

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

async function saveProofToDisk(base64String) {
  if (!base64String) {
    return null;
  }

  const matches = base64String.match(/^data:(.+);base64,(.+)$/);
  if (!matches) {
    throw new Error('Invalid proof format');
  }

  const mimeType = matches[1];
  const data = matches[2];
  const buffer = Buffer.from(data, 'base64');
  const extension = mimeType.split('/')[1] || 'bin';
  const uniqueId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const fileName = `payout-${Date.now()}-${uniqueId}.${extension}`;
  const uploadDir = path.join(process.cwd(), 'uploads');
  await fs.mkdir(uploadDir, { recursive: true });
  const filePath = path.join(uploadDir, fileName);
  await fs.writeFile(filePath, buffer);
  return fileName;
}

const { findUserByEmail, getUserRoles, hasPermission } = require('../services/userService');

async function payoutRequestRoutes(app) {
  // Create payout request
  app.post('/', {
    preValidation: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['amount', 'utr', 'remarks', 'proof'],
        properties: {
          amount: { type: 'number', minimum: 0.01 },
          utr: { type: 'string', minLength: 4 },
          remarks: { type: 'string', minLength: 1 },
          proof: { type: 'string', minLength: 1 },
          book_id: { type: 'string', format: 'uuid' }, // Optional book_id
        },
      },
    },
  }, async (request, reply) => {
    const { amount, utr, remarks, proof, book_id } = request.body;

    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      const proofFilename = await saveProofToDisk(proof);

      // If book_id is provided, verify it exists and belongs to the user
      if (book_id) {
        const bookCheck = await app.pg.query(
          'SELECT id FROM public.books WHERE id = $1 AND owner_user_id = $2',
          [book_id, user.id]
        );
        if (bookCheck.rows.length === 0) {
          return reply.code(400).send({ message: 'Book not found or does not belong to user' });
        }
      }

      const result = await app.pg.query(
        `INSERT INTO public.payout_requests (user_id, amount, utr, remarks, proof_filename, book_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')
         RETURNING id, status, created_at, proof_filename, amount, book_id`,
        [user.id, amount, utr, remarks, proofFilename, book_id || null],
      );

      reply.code(201).send({ request: result.rows[0] });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to create payout request');
      reply.code(500).send({ message: 'Failed to create payout request' });
    }
  });

  // Get all payout requests (for admin)
  app.get('/', {
    preValidation: [app.authenticate],
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Check if user has permission to view payouts
      const canView = await hasPermission(app.pg, user.id, 'payouts.view');
      if (!canView) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to view payout requests.' });
      }

      // Get user roles for filtering (managers see only their business payouts)
      const roles = await getUserRoles(app.pg, user.id);
      const isAdmin = roles.includes('admin');
      const isManager = roles.includes('managers') || roles.includes('manager');
      const isStaff = roles.includes('staff') || roles.includes('agents');

      // Check if payout_requests table exists
      const tableCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'payout_requests'
        );
      `);

      if (!tableCheck.rows[0]?.exists) {
        return reply.send({ payoutRequests: [] });
      }

      // Check if user_id column exists
      const columnsCheck = await app.pg.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'payout_requests' 
        AND column_name = 'user_id'
      `);

      const hasUserId = columnsCheck.rows.length > 0;

      const { status } = request.query;

      let query;
      
      // Check if updated_at column exists, otherwise use created_at
      const updatedAtCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.columns 
          WHERE table_schema = 'public' 
          AND table_name = 'payout_requests' 
          AND column_name = 'updated_at'
        );
      `);
      const hasUpdatedAt = updatedAtCheck.rows[0]?.exists;
      const updatedAtField = hasUpdatedAt ? 'pr.updated_at' : 'pr.created_at';
      
      if (hasUserId) {
        query = `
          SELECT 
            pr.id,
            pr.amount,
            pr.utr,
            pr.remarks,
            pr.status,
            pr.book_id,
            pr.proof_filename,
            pr.created_at,
            ${updatedAtField} as updated_at,
            u.email as user_email,
            ud.first_name,
            ud.last_name,
            ud.phone as user_phone,
            COALESCE(
              (SELECT r.name
               FROM public.user_roles ur_sub
               JOIN public.roles r ON ur_sub.role_id = r.id
               WHERE ur_sub.user_id = u.id
               ORDER BY ur_sub.assigned_at ASC
               LIMIT 1),
              'staff'
            ) as user_role
          FROM public.payout_requests pr
          LEFT JOIN public.users u ON pr.user_id = u.id
          LEFT JOIN public.user_details ud ON u.id = ud.user_id
        `;
      } else {
        // Fallback if user_id column doesn't exist
        query = `
          SELECT 
            pr.id,
            pr.amount,
            pr.utr,
            pr.remarks,
            pr.status,
            pr.proof_filename,
            pr.created_at,
            ${updatedAtField} as updated_at,
            NULL::text as user_email,
            NULL::text as first_name,
            NULL::text as last_name,
            NULL::text as user_phone,
            'staff' as user_role
          FROM public.payout_requests pr
        `;
      }

      const params = [];
      let paramIndex = 1;

      // For staff users, only show their own payout requests
      if (isStaff && !isAdmin && !isManager) {
        if (hasUserId) {
          query += ' WHERE pr.user_id = $' + paramIndex;
          params.push(user.id);
          paramIndex++;
        } else {
          // If user_id column doesn't exist, return empty for staff
          return reply.send({ payoutRequests: [] });
        }
      }
      // For managers, filter by staff they created
      else if (isManager && !isAdmin) {
        // Get all staff users created by this manager
        const staffResult = await app.pg.query(
          `SELECT id FROM public.users WHERE created_by = $1`,
          [user.id]
        );
        const staffUserIds = staffResult.rows.map(s => s.id);

        if (staffUserIds.length > 0) {
          // Filter payout requests by staff user IDs
          query += ' WHERE pr.user_id = ANY($' + paramIndex + '::uuid[])';
          params.push(staffUserIds);
          paramIndex++;
        } else {
          // No staff created by this manager, return empty result
          return reply.send({ payoutRequests: [] });
        }
      }

      if (status && status !== 'all') {
        if (params.length > 0) {
          query += ' AND pr.status = $' + paramIndex;
        } else {
          query += ' WHERE pr.status = $' + paramIndex;
        }
        params.push(status);
        paramIndex++;
      }

      query += ' ORDER BY pr.created_at DESC';

      const result = await app.pg.query(query, params.length > 0 ? params : undefined);

      const payoutRequests = result.rows.map((row) => {
        const fullName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || row.user_email?.split('@')[0] || 'Unknown';
        // Generate reference from ID and timestamp
        const shortId = row.id.replace(/-/g, '').substring(0, 8).toUpperCase();
        const year = new Date(row.created_at).getFullYear();
        const reference = `REQ-${year}-${shortId}`;

        // Debug: log proof_filename value
        request.log.info({ 
          rowId: row.id, 
          proof_filename: row.proof_filename,
          hasProofFilename: !!row.proof_filename 
        }, 'Processing payout request');

        return {
          id: row.id,
          reference,
          submittedBy: `${fullName} (${row.user_role || 'Staff'})`,
          amount: parseFloat(row.amount),
          utr: row.utr,
          remarks: row.remarks,
          status: row.status,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          userEmail: row.user_email,
          userPhone: row.user_phone || null,
          proofFilename: row.proof_filename || null,
        };
      });

      return reply.send({ payoutRequests });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
        code: error.code,
        detail: error.detail,
        hint: error.hint
      }, 'Failed to fetch payout requests');
      
      const errorMessage = error.detail || error.message || 'Failed to fetch payout requests';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Delete payout request (admin only) - must be before /:id/status route
  app.delete('/:id', {
    preValidation: [app.authenticate],
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      const roles = await getUserRoles(app.pg, user.id);
      const isAdmin = roles.includes('admin');
      const isManager = roles.includes('managers') || roles.includes('manager');

      const { id } = request.params;

      // Check if payout request exists and get proof filename and user_id
      const existing = await app.pg.query(
        'SELECT id, proof_filename, user_id FROM public.payout_requests WHERE id = $1',
        [id]
      );

      if (existing.rows.length === 0) {
        return reply.code(404).send({ message: 'Payout request not found' });
      }

      const payoutRequest = existing.rows[0];

      // Check permissions: admin can delete any, staff can delete their own, managers can delete their staff's requests
      if (!isAdmin) {
        if (payoutRequest.user_id === user.id) {
          // User owns this payout request - allow deletion
        } else if (isManager) {
          // Check if this payout request belongs to a staff member created by this manager
          const staffCheck = await app.pg.query(
            'SELECT id FROM public.users WHERE id = $1 AND created_by = $2',
            [payoutRequest.user_id, user.id]
          );
          if (staffCheck.rows.length === 0) {
            return reply.code(403).send({ message: 'Access denied. You can only delete your own payout requests or those from your staff members.' });
          }
        } else {
          // Staff user trying to delete someone else's request
          return reply.code(403).send({ message: 'Access denied. You can only delete your own payout requests.' });
        }
      }

      // Delete proof file if it exists
      if (payoutRequest.proof_filename) {
        try {
          const fs = require('fs').promises;
          const path = require('path');
          const uploadDir = path.join(process.cwd(), 'uploads');
          const proofPath = path.join(uploadDir, payoutRequest.proof_filename);
          await fs.unlink(proofPath).catch(() => {
            // File doesn't exist or can't be deleted - that's okay
          });
        } catch (fileError) {
          request.log.warn({ err: fileError }, 'Failed to delete payout request proof file');
        }
      }

      // Delete payout request
      const deleteResult = await app.pg.query(
        'DELETE FROM public.payout_requests WHERE id = $1',
        [id]
      );

      if (deleteResult.rowCount === 0) {
        return reply.code(404).send({ message: 'Payout request not found or already deleted' });
      }

      return reply.send({
        success: true,
        message: 'Payout request deleted successfully',
      });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
        code: error.code,
        detail: error.detail
      }, 'Failed to delete payout request');
      
      const errorMessage = error.detail || error.message || 'Failed to delete payout request';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Update payout request status (accept/reject)
  app.patch('/:id/status', {
    preValidation: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['status', 'notes'],
        properties: {
          status: { type: 'string', enum: ['accepted', 'rejected'] },
          notes: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      const { id } = request.params;
      const { status, notes } = request.body;

      // Check permissions based on action
      if (status === 'accepted') {
        const canApprove = await hasPermission(app.pg, user.id, 'payouts.approve');
        if (!canApprove) {
          return reply.code(403).send({ message: 'Access denied. You do not have permission to approve payout requests.' });
        }
      } else if (status === 'rejected') {
        const canReject = await hasPermission(app.pg, user.id, 'payouts.reject');
        if (!canReject) {
          return reply.code(403).send({ message: 'Access denied. You do not have permission to reject payout requests.' });
        }
      }

      // Get user roles for business filtering (managers can only approve their own business payouts)
      const roles = await getUserRoles(app.pg, user.id);
      const isAdmin = roles.includes('admin');
      const isManager = roles.includes('managers') || roles.includes('manager');

      // Check if request exists and is pending, get full details
      const existing = await app.pg.query(
        `SELECT pr.id, pr.status, pr.amount, pr.utr, pr.remarks, pr.user_id, pr.book_id, pr.created_at,
               b.business_id, pr.business_id as payout_business_id
         FROM public.payout_requests pr
         LEFT JOIN public.books b ON pr.book_id = b.id
         WHERE pr.id = $1`,
        [id]
      );

      if (existing.rows.length === 0) {
        return reply.code(404).send({ message: 'Payout request not found' });
      }

      if (existing.rows[0].status !== 'pending') {
        return reply.code(400).send({ message: 'Request is not in pending status' });
      }

      const payoutRequest = existing.rows[0];

      // For managers (not admin), verify they created the staff who made the payout request
      if (isManager && !isAdmin && payoutRequest.user_id) {
        const staffCheck = await app.pg.query(
          'SELECT id FROM public.users WHERE id = $1 AND created_by = $2',
          [payoutRequest.user_id, user.id]
        );
        
        if (staffCheck.rows.length === 0) {
          return reply.code(403).send({ message: 'Access denied. You can only approve payout requests from staff you created.' });
        }
      }

      // Check if updated_at column exists
      const updatedAtCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.columns 
          WHERE table_schema = 'public' 
          AND table_name = 'payout_requests' 
          AND column_name = 'updated_at'
        );
      `);
      const hasUpdatedAt = updatedAtCheck.rows[0]?.exists;

      // Start a transaction to ensure atomicity
      const client = await app.pg.connect();
      try {
        await client.query('BEGIN');

        // Update payout request status
        const result = await client.query(
          `UPDATE public.payout_requests
           SET status = $1${hasUpdatedAt ? ', updated_at = now()' : ''}
           WHERE id = $2
           RETURNING id, status, amount, utr, remarks, created_at${hasUpdatedAt ? ', updated_at' : ''}`,
          [status, id]
        );

        // If accepted, create a Cash-Out entry in Payout Book
        if (status === 'accepted') {
          // If no user_id, skip entry creation but still update status
          if (!payoutRequest.user_id) {
            request.log.warn({ payout_request_id: id }, 'Payout request accepted but no user_id, skipping entry creation');
          } else {
            // Get the staff user who created the payout request
            const staffUserResult = await client.query(
              'SELECT id, created_by FROM public.users WHERE id = $1',
              [payoutRequest.user_id]
            );

            if (staffUserResult.rows.length === 0) {
              request.log.warn({ payout_request_id: id, user_id: payoutRequest.user_id }, 'Staff user not found, skipping entry creation');
            } else {
              const staffUser = staffUserResult.rows[0];
              const managerId = staffUser.created_by || user.id; // Fallback to current user if no created_by

              // Get manager's business (first business owned by manager)
              const businessResult = await client.query(
                `SELECT id FROM public.businesses 
                 WHERE owner_user_id = $1 
                 ORDER BY created_at ASC 
                 LIMIT 1`,
                [managerId]
              );

              if (businessResult.rows.length === 0) {
                request.log.warn({ payout_request_id: id, manager_id: managerId }, 'Manager business not found, skipping entry creation');
              } else {
                const businessId = businessResult.rows[0].id;

                // Find or create "Payout Book" for this business
                let payoutBookResult = await client.query(
                  `SELECT id FROM public.books 
                   WHERE business_id = $1 AND LOWER(name) = 'payout book'
                   ORDER BY created_at ASC 
                   LIMIT 1`,
                  [businessId]
                );

                let payoutBookId;
                if (payoutBookResult.rows.length > 0) {
                  payoutBookId = payoutBookResult.rows[0].id;
                } else {
                  // Create Payout Book if it doesn't exist
                  const createBookResult = await client.query(
                    `INSERT INTO public.books (name, description, owner_user_id, business_id, currency_code)
                     VALUES ($1, $2, $3, $4, $5)
                     RETURNING id`,
                    ['Payout Book', 'Payout requests cash out entries', managerId, businessId, 'INR']
                  );
                  payoutBookId = createBookResult.rows[0].id;
                  request.log.info({ payout_book_id: payoutBookId, business_id: businessId }, 'Created Payout Book');
                }

                // Get staff user details for entry
                const staffDetailsResult = await client.query(
                  `SELECT first_name, last_name, email FROM public.user_details ud
                   JOIN public.users u ON ud.user_id = u.id
                   WHERE u.id = $1`,
                  [payoutRequest.user_id]
                );

                const staffName = staffDetailsResult.rows.length > 0
                  ? [staffDetailsResult.rows[0].first_name, staffDetailsResult.rows[0].last_name].filter(Boolean).join(' ').trim() || staffDetailsResult.rows[0].email?.split('@')[0] || 'Staff'
                  : 'Staff';

                // Create Cash-Out entry in Payout Book
                const now = new Date();
                const entryDate = now.toISOString().split('T')[0]; // YYYY-MM-DD
                const entryTime = now.toTimeString().split(' ')[0]; // HH:MM:SS

                await client.query(
                  `INSERT INTO public.entries (
                    book_id, entry_type, amount, party_name, 
                    payment_mode, remarks, entry_date, entry_time, created_by
                  )
                  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                  [
                    payoutBookId,
                    'cash_out',
                    payoutRequest.amount,
                    staffName, // Party name = staff who requested
                    'UPI', // Payment mode
                    `Payout Request: ${payoutRequest.utr} - ${payoutRequest.remarks}${notes ? ` | Notes: ${notes}` : ''}`,
                    entryDate,
                    entryTime,
                    user.id, // Created by the manager who approved
                  ]
                );

                // Update wallet balance if wallet exists (decrease balance for cash-out)
                const walletResult = await client.query(
                  'SELECT id FROM public.user_wallets WHERE user_id = $1',
                  [payoutRequest.user_id]
                );
                const walletId = walletResult.rows.length > 0 ? walletResult.rows[0].id : null;

                if (walletId) {
                  await client.query(
                    `UPDATE public.user_wallets 
                     SET balance = balance - $1, updated_at = now()
                     WHERE id = $2`,
                    [payoutRequest.amount, walletId]
                  );
                }

                request.log.info({
                  payout_request_id: id,
                  user_id: payoutRequest.user_id,
                  amount: payoutRequest.amount,
                  payout_book_id: payoutBookId,
                  business_id: businessId,
                  wallet_id: walletId,
                }, 'Cash-Out entry created in Payout Book for accepted payout request');
              }
            }
          }
        }

        await client.query('COMMIT');

        return reply.send({
          success: true,
          request: result.rows[0],
          transactionCreated: status === 'accepted',
        });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {}); // Ignore rollback errors
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
      }, 'Failed to update payout request status');
      
      const errorMessage = error.detail || error.message || 'Failed to update payout request status';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });
}

module.exports = payoutRequestRoutes;

