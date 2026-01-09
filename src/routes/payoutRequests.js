// Payout Requests Routes for Admin Panel
// This is used by hissabbook-react-admin (NOT hissabbook-api-system)

const fs = require('fs/promises');
const path = require('path');
const { uploadProofToR2, deleteFromR2 } = require('../utils/r2Upload');

// Legacy function for backward compatibility (if R2 is not configured)
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
  const crypto = require('crypto');
  const uniqueId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const fileName = `payout-${Date.now()}-${uniqueId}.${extension}`;
  const uploadDir = path.join(process.cwd(), 'uploads');
  await fs.mkdir(uploadDir, { recursive: true });
  const filePath = path.join(uploadDir, fileName);
  await fs.writeFile(filePath, buffer);
  return fileName;
}

// Upload proof to R2 or fallback to disk
async function saveProof(base64String) {
  // Check if R2 is configured
  const hasR2Config = process.env.R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY;
  
  // Debug logging
  console.log('=== R2 Upload Check ===');
  console.log('R2_ENDPOINT:', process.env.R2_ENDPOINT ? 'SET' : 'NOT SET');
  console.log('R2_ACCESS_KEY_ID:', process.env.R2_ACCESS_KEY_ID ? 'SET' : 'NOT SET');
  console.log('R2_SECRET_ACCESS_KEY:', process.env.R2_SECRET_ACCESS_KEY ? 'SET' : 'NOT SET');
  console.log('R2_BUCKET_NAME:', process.env.R2_BUCKET_NAME || 'hissabbook (default)');
  console.log('R2_PUBLIC_URL:', process.env.R2_PUBLIC_URL || 'NOT SET');
  console.log('Has R2 Config:', hasR2Config);
  
  if (!hasR2Config) {
    console.warn('⚠️  R2 not configured - missing environment variables. Using disk storage.');
    console.warn('Required: R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
    return await saveProofToDisk(base64String);
  }
  
  try {
    console.log('✅ Attempting to upload proof to R2...');
    const result = await uploadProofToR2(base64String);
    console.log('✅ Successfully uploaded to R2:', result.url);
    // Store the R2 URL in proof_filename column
    return result.url;
  } catch (error) {
    // Log detailed error but fallback to disk storage
    console.error('❌ Failed to upload to R2, falling back to disk storage');
    console.error('R2 Error:', error.message);
    console.error('Error stack:', error.stack);
    return await saveProofToDisk(base64String);
  }
}

const { findUserByEmail, getUserRoles, hasPermission } = require('../services/userService');

async function payoutRequestRoutes(app) {
  // Check if UTR exists
  app.get('/check-utr/:utr', {
    preValidation: [app.authenticate],
  }, async (request, reply) => {
    const { utr } = request.params;

    try {
      const result = await app.pg.query(
        'SELECT id FROM public.payout_requests WHERE utr = $1 LIMIT 1',
        [utr],
      );

      if (result.rows.length > 0) {
        return reply.send({ exists: true });
      }

      return reply.send({ exists: false });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to check UTR');
      reply.code(500).send({ message: 'Failed to check UTR' });
    }
  });

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

      // Check if UTR already exists
      const utrCheck = await app.pg.query(
        'SELECT id FROM public.payout_requests WHERE utr = $1 LIMIT 1',
        [utr],
      );

      if (utrCheck.rows.length > 0) {
        return reply.code(400).send({ message: 'UTR already existed in our record' });
      }

      // Upload proof to R2 (or fallback to disk if R2 not configured)
      const proofUrlOrFilename = await saveProof(proof);
      
      // Log upload details
      const isR2Url = proofUrlOrFilename && proofUrlOrFilename.startsWith('http');
      request.log.info({
        proofUrlOrFilename,
        storageType: isR2Url ? 'R2' : 'disk',
        uploaded: true,
        r2Configured: !!(process.env.R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY)
      }, 'Payout proof file uploaded');

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
        [user.id, amount, utr, remarks, proofUrlOrFilename, book_id || null],
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

      const { status, page, limit } = request.query;
      
      // Pagination parameters
      const pageNum = parseInt(page) || 1;
      const limitNum = parseInt(limit) || 10;
      const offset = (pageNum - 1) * limitNum;

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
      let countParams = [];
      let countWhereClause = '';

      // For staff users, only show their own payout requests
      if (isStaff && !isAdmin && !isManager) {
        if (hasUserId) {
          query += ' WHERE pr.user_id = $' + paramIndex;
          params.push(user.id);
          paramIndex++;
          
          // Build count query condition
          countWhereClause = ' WHERE pr.user_id = $1';
          countParams.push(user.id);
        } else {
          // If user_id column doesn't exist, return empty for staff
          return reply.send({ payoutRequests: [], pagination: { page: pageNum, limit: limitNum, total: 0, totalPages: 0 } });
        }
      }
      // For managers, filter by staff who are members of their books OR staff they created
      else if (isManager && !isAdmin) {
        // Get all books owned by this manager
        const booksResult = await app.pg.query(
          `SELECT id FROM public.books WHERE owner_user_id = $1`,
          [user.id]
        );
        const bookIds = booksResult.rows.map(b => b.id);

        // Get all staff users who are members of manager's books
        let staffUserIds = [];
        if (bookIds.length > 0) {
          const bookMembersResult = await app.pg.query(
            `SELECT DISTINCT user_id FROM public.book_users WHERE book_id = ANY($1::uuid[])`,
            [bookIds]
          );
          staffUserIds = bookMembersResult.rows.map(m => m.user_id);
        }

        // Also include staff directly created by this manager
        const createdStaffResult = await app.pg.query(
          `SELECT id FROM public.users WHERE created_by = $1`,
          [user.id]
        );
        const createdStaffIds = createdStaffResult.rows.map(s => s.id);
        
        // Combine both sets of user IDs (remove duplicates)
        const allStaffUserIds = [...new Set([...staffUserIds, ...createdStaffIds])];

        if (allStaffUserIds.length > 0) {
          // Filter payout requests by staff user IDs
          query += ' WHERE pr.user_id = ANY($' + paramIndex + '::uuid[])';
          params.push(allStaffUserIds);
          paramIndex++;
          
          // Build count query condition
          countWhereClause = ' WHERE pr.user_id = ANY($1::uuid[])';
          countParams.push(allStaffUserIds);
        } else {
          // No staff members in manager's books, return empty result
          return reply.send({ payoutRequests: [], pagination: { page: pageNum, limit: limitNum, total: 0, totalPages: 0 } });
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
        
        // Add to count query
        if (countWhereClause) {
          countWhereClause += ' AND pr.status = $' + (countParams.length + 1);
        } else {
          countWhereClause = ' WHERE pr.status = $1';
        }
        countParams.push(status);
      }

      // Get total count for pagination (before ORDER BY and pagination)
      // Build a simple count query with the same WHERE conditions
      const countQuery = 'SELECT COUNT(*) as total FROM public.payout_requests pr' + countWhereClause;
      const countResult = await app.pg.query(countQuery, countParams.length > 0 ? countParams : undefined);
      const total = parseInt(countResult.rows[0]?.total || 0);

      // Apply ORDER BY and pagination to main query
      query += ' ORDER BY pr.created_at DESC';
      query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(limitNum, offset);
      paramIndex += 2;

      const result = await app.pg.query(query, params);

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

      return reply.send({ 
        payoutRequests,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum),
        }
      });
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

  // Update payout request (edit amount, utr, remarks, proof)
  // IMPORTANT: This must be registered BEFORE /:id/status to avoid route conflicts
  app.put('/:id', {
    preValidation: [app.authenticate],
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
      body: {
        type: 'object',
        required: ['amount', 'utr', 'remarks'],
        properties: {
          amount: { type: 'number', minimum: 0.01 },
          utr: { type: 'string', minLength: 4 },
          remarks: { type: 'string', minLength: 1 },
          proof: { type: 'string' }, // Optional - only if updating proof
        },
      },
    },
  }, async (request, reply) => {
    request.log.info({ method: 'PUT', url: request.url, params: request.params, body: request.body }, 'PUT /:id handler called');
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Check if user has permission to update payouts
      const canUpdate = await hasPermission(app.pg, user.id, 'payouts.update');
      const roles = await getUserRoles(app.pg, user.id);
      const isAdmin = roles.includes('admin');
      
      request.log.info({ userId: user.id, canUpdate, isAdmin }, 'Permission check for payout update');
      
      if (!canUpdate && !isAdmin) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to update payout requests.' });
      }

      const { id } = request.params;
      const { amount, utr, remarks, proof } = request.body;

      // Check if payout request exists
      const existing = await app.pg.query(
        `SELECT id, user_id, status, proof_filename, book_id FROM public.payout_requests WHERE id = $1`,
        [id]
      );

      if (existing.rows.length === 0) {
        return reply.code(404).send({ message: 'Payout request not found' });
      }

      const payoutRequest = existing.rows[0];

      // If proof is provided, upload new proof (to R2 or disk)
      let proofFilename = payoutRequest.proof_filename;
      if (proof) {
        // Delete old proof if it exists
        if (proofFilename) {
          const isR2Url = proofFilename.startsWith('http');
          if (isR2Url) {
            // Extract key from R2 URL for deletion
            const urlParts = proofFilename.split('/');
            const domainIndex = urlParts.findIndex(part => part.includes('r2.dev') || part.includes('r2.cloudflarestorage.com'));
            if (domainIndex >= 0 && domainIndex < urlParts.length - 1) {
              const key = urlParts.slice(domainIndex + 1).join('/');
              await deleteFromR2(key).catch((err) => {
                request.log.warn({ err, key }, 'Failed to delete old proof from R2');
              });
            }
          } else {
            // Delete from local disk
            const fs = require('fs').promises;
            const path = require('path');
            const uploadDir = path.join(process.cwd(), 'uploads');
            const proofPath = path.join(uploadDir, proofFilename);
            await fs.unlink(proofPath).catch((err) => {
              request.log.warn({ err, proofPath }, 'Failed to delete old proof from disk');
            });
          }
        }

        // Upload new proof
        const proofUrlOrFilename = await saveProof(proof);
        proofFilename = proofUrlOrFilename;
        
        request.log.info({
          proofUrlOrFilename,
          storageType: proofUrlOrFilename.startsWith('http') ? 'R2' : 'disk',
        }, 'Updated payout proof file');
      }

      // Update payout request
      const result = await app.pg.query(
        `UPDATE public.payout_requests
         SET amount = $1, utr = $2, remarks = $3, proof_filename = $4, updated_at = now()
         WHERE id = $5
         RETURNING id, amount, utr, remarks, proof_filename, status, created_at, updated_at`,
        [amount, utr, remarks, proofFilename, id]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ message: 'Payout request not found or update failed' });
      }

      return reply.send({ 
        payoutRequest: result.rows[0],
        message: 'Payout request updated successfully'
      });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to update payout request');
      return reply.code(500).send({
        message: 'Failed to update payout request',
        error: error.message
      });
    }
  });

  // Delete payout request - must be before /:id/status route
  app.delete('/:id', {
    preValidation: [app.authenticate],
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Check if user has permission to delete payouts
      const canDelete = await hasPermission(app.pg, user.id, 'payouts.delete');
      if (!canDelete) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to delete payout requests.' });
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

      // Additional access checks: admin can delete any, staff can delete their own, managers can delete their staff's requests
      if (!isAdmin) {
        if (payoutRequest.user_id === user.id) {
          // User owns this payout request - allow deletion
        } else if (isManager) {
          // Check if this payout request belongs to a staff member who is in manager's books
          // Get all books owned by this manager
          const booksResult = await app.pg.query(
            `SELECT id FROM public.books WHERE owner_user_id = $1`,
            [user.id]
          );
          const bookIds = booksResult.rows.map(b => b.id);

          // Check if staff is a member of any of manager's books
          let isStaffMember = false;
          if (bookIds.length > 0) {
            const bookMemberCheck = await app.pg.query(
              `SELECT 1 FROM public.book_users WHERE book_id = ANY($1::uuid[]) AND user_id = $2 LIMIT 1`,
              [bookIds, payoutRequest.user_id]
            );
            isStaffMember = bookMemberCheck.rows.length > 0;
          }

          // Also check if staff was created by this manager
          const createdStaffCheck = await app.pg.query(
            'SELECT id FROM public.users WHERE id = $1 AND created_by = $2',
            [payoutRequest.user_id, user.id]
          );
          const isCreatedStaff = createdStaffCheck.rows.length > 0;

          if (!isStaffMember && !isCreatedStaff) {
            return reply.code(403).send({ message: 'Access denied. You can only delete your own payout requests or those from your staff members.' });
          }
        } else {
          // Staff user trying to delete someone else's request
          return reply.code(403).send({ message: 'Access denied. You can only delete your own payout requests.' });
        }
      }

      // Delete proof file if it exists (from R2 or disk)
      if (payoutRequest.proof_filename) {
        try {
          const isR2Url = payoutRequest.proof_filename.startsWith('http');
          if (isR2Url) {
            // Extract key from R2 URL for deletion (includes path like screenshots/filename)
            // URL format: https://bucket.account.r2.cloudflarestorage.com/screenshots/payout-xxx.jpg
            const urlParts = payoutRequest.proof_filename.split('/');
            // Get everything after the bucket/account part (e.g., screenshots/payout-xxx.jpg)
            const bucketIndex = urlParts.findIndex(part => part.includes('r2.cloudflarestorage.com'));
            if (bucketIndex >= 0 && bucketIndex < urlParts.length - 1) {
              const key = urlParts.slice(bucketIndex + 1).join('/'); // e.g., screenshots/payout-xxx.jpg
              await deleteFromR2(key).catch(() => {
                // File doesn't exist or can't be deleted - that's okay
              });
            }
          } else {
            // Delete from local disk
            const fs = require('fs').promises;
            const path = require('path');
            const uploadDir = path.join(process.cwd(), 'uploads');
            const proofPath = path.join(uploadDir, payoutRequest.proof_filename);
            await fs.unlink(proofPath).catch(() => {
              // File doesn't exist or can't be deleted - that's okay
            });
          }
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
               pr.proof_filename, b.business_id, pr.business_id as payout_business_id
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

      // For managers (not admin), verify the staff who made the payout request is in their books or was created by them
      if (isManager && !isAdmin && payoutRequest.user_id) {
        // Get all books owned by this manager
        const booksResult = await app.pg.query(
          `SELECT id FROM public.books WHERE owner_user_id = $1`,
          [user.id]
        );
        const bookIds = booksResult.rows.map(b => b.id);

        // Check if staff is a member of any of manager's books
        let isStaffMember = false;
        if (bookIds.length > 0) {
          const bookMemberCheck = await app.pg.query(
            `SELECT 1 FROM public.book_users WHERE book_id = ANY($1::uuid[]) AND user_id = $2 LIMIT 1`,
            [bookIds, payoutRequest.user_id]
          );
          isStaffMember = bookMemberCheck.rows.length > 0;
        }

        // Also check if staff was created by this manager
        const createdStaffCheck = await app.pg.query(
          'SELECT id FROM public.users WHERE id = $1 AND created_by = $2',
          [payoutRequest.user_id, user.id]
        );
        const isCreatedStaff = createdStaffCheck.rows.length > 0;

        if (!isStaffMember && !isCreatedStaff) {
          return reply.code(403).send({ message: 'Access denied. You can only approve payout requests from staff who are members of your books.' });
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

        // If accepted, create a Cash-Out entry in the specified book or Payout Book
        if (status === 'accepted') {
          // If no user_id, skip entry creation but still update status
          if (!payoutRequest.user_id) {
            request.log.warn({ payout_request_id: id }, 'Payout request accepted but no user_id, skipping entry creation');
          } else {
            let targetBookId = null;

            // If book_id is provided in payout request, use that book
            if (payoutRequest.book_id) {
              // Verify the book exists and user has access to it
              const bookCheck = await client.query(
                `SELECT b.id, b.owner_user_id, b.business_id 
                 FROM public.books b
                 WHERE b.id = $1`,
                [payoutRequest.book_id]
              );

              if (bookCheck.rows.length > 0) {
                const book = bookCheck.rows[0];
                // Check if user has access to this book (owner, admin, or member)
                const isBookOwner = book.owner_user_id === user.id;
                const isBookMember = await client.query(
                  'SELECT 1 FROM public.book_users WHERE book_id = $1 AND user_id = $2',
                  [payoutRequest.book_id, user.id]
                );

                if (isAdmin || isBookOwner || isBookMember.rows.length > 0) {
                  targetBookId = payoutRequest.book_id;
                  request.log.info({ payout_request_id: id, book_id: targetBookId }, 'Using specified book from payout request');
                } else {
                  request.log.warn({ payout_request_id: id, book_id: payoutRequest.book_id }, 'User does not have access to specified book, will use Payout Book');
                }
              } else {
                request.log.warn({ payout_request_id: id, book_id: payoutRequest.book_id }, 'Specified book not found, will use Payout Book');
              }
            }

            // If no target book yet, find the book the staff member belongs to
            if (!targetBookId) {
              // Get all books owned by the manager (current user approving)
              const managerBooksResult = await client.query(
                `SELECT id FROM public.books WHERE owner_user_id = $1`,
                [user.id]
              );
              const managerBookIds = managerBooksResult.rows.map(b => b.id);

              if (managerBookIds.length > 0) {
                // Find which book(s) the staff member is a member of
                const staffBooksResult = await client.query(
                  `SELECT book_id FROM public.book_users 
                   WHERE book_id = ANY($1::uuid[]) AND user_id = $2
                   ORDER BY added_at ASC`,
                  [managerBookIds, payoutRequest.user_id]
                );

                if (staffBooksResult.rows.length > 0) {
                  // Staff is a member of at least one book
                  // If book_id was provided in payout request but wasn't valid, prefer it if staff is a member
                  if (payoutRequest.book_id && staffBooksResult.rows.some(r => r.book_id === payoutRequest.book_id)) {
                    targetBookId = payoutRequest.book_id;
                    request.log.info({ payout_request_id: id, book_id: targetBookId }, 'Using book from payout request (staff is member)');
                  } else {
                    // Use the first book the staff is a member of
                    targetBookId = staffBooksResult.rows[0].book_id;
                    request.log.info({ payout_request_id: id, book_id: targetBookId }, 'Using staff member book for cashout entry');
                  }
                } else {
                  // Staff is not a member of any book owned by manager, fall back to Payout Book
                  request.log.warn({ payout_request_id: id, user_id: payoutRequest.user_id }, 'Staff is not a member of any manager book, falling back to Payout Book');
                  
                  // Get manager's business (first business owned by manager)
                  const businessResult = await client.query(
                    `SELECT id FROM public.businesses 
                     WHERE owner_user_id = $1 
                     ORDER BY created_at ASC 
                     LIMIT 1`,
                    [user.id]
                  );

                  if (businessResult.rows.length > 0) {
                    const businessId = businessResult.rows[0].id;

                    // Find or create "Payout Book" for this business
                    let payoutBookResult = await client.query(
                      `SELECT id FROM public.books 
                       WHERE business_id = $1 AND LOWER(name) = 'payout book'
                       ORDER BY created_at ASC 
                       LIMIT 1`,
                      [businessId]
                    );

                    if (payoutBookResult.rows.length > 0) {
                      targetBookId = payoutBookResult.rows[0].id;
                    } else {
                      // Create Payout Book if it doesn't exist
                      const createBookResult = await client.query(
                        `INSERT INTO public.books (name, description, owner_user_id, business_id, currency_code)
                         VALUES ($1, $2, $3, $4, $5)
                         RETURNING id`,
                        ['Payout Book', 'Payout requests cash out entries', user.id, businessId, 'INR']
                      );
                      targetBookId = createBookResult.rows[0].id;
                      request.log.info({ payout_book_id: targetBookId, business_id: businessId }, 'Created Payout Book as fallback');
                    }
                  } else {
                    request.log.warn({ payout_request_id: id, manager_id: user.id }, 'Manager business not found, skipping entry creation');
                  }
                }
              } else {
                // Manager has no books, fall back to Payout Book
                request.log.warn({ payout_request_id: id, manager_id: user.id }, 'Manager has no books, falling back to Payout Book');
                
                // Get manager's business (first business owned by manager)
                const businessResult = await client.query(
                  `SELECT id FROM public.businesses 
                   WHERE owner_user_id = $1 
                   ORDER BY created_at ASC 
                   LIMIT 1`,
                  [user.id]
                );

                if (businessResult.rows.length > 0) {
                  const businessId = businessResult.rows[0].id;

                  // Find or create "Payout Book" for this business
                  let payoutBookResult = await client.query(
                    `SELECT id FROM public.books 
                     WHERE business_id = $1 AND LOWER(name) = 'payout book'
                     ORDER BY created_at ASC 
                     LIMIT 1`,
                    [businessId]
                  );

                  if (payoutBookResult.rows.length > 0) {
                    targetBookId = payoutBookResult.rows[0].id;
                  } else {
                    // Create Payout Book if it doesn't exist
                    const createBookResult = await client.query(
                      `INSERT INTO public.books (name, description, owner_user_id, business_id, currency_code)
                       VALUES ($1, $2, $3, $4, $5)
                       RETURNING id`,
                      ['Payout Book', 'Payout requests cash out entries', user.id, businessId, 'INR']
                    );
                    targetBookId = createBookResult.rows[0].id;
                    request.log.info({ payout_book_id: targetBookId, business_id: businessId }, 'Created Payout Book as fallback');
                  }
                } else {
                  request.log.warn({ payout_request_id: id, manager_id: user.id }, 'Manager business not found, skipping entry creation');
                }
              }
            }

            // Create entry in the target book if we have one
            if (targetBookId) {
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

              // Create Cash-Out entry in the target book
              const now = new Date();
              const entryDate = now.toISOString().split('T')[0]; // YYYY-MM-DD
              const entryTime = now.toTimeString().split(' ')[0]; // HH:MM:SS

              const entryResult = await client.query(
                `INSERT INTO public.entries (
                  book_id, entry_type, amount, party_name, 
                  payment_mode, remarks, entry_date, entry_time, created_by
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                RETURNING id`,
                [
                  targetBookId,
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

              const entryId = entryResult.rows[0].id;

              // Update book's updated_at timestamp when entry is created from payout request
              await client.query(
                `UPDATE public.books SET updated_at = now() WHERE id = $1`,
                [targetBookId]
              );

              // Link the proof file from payout request to the entry attachment if it exists
              if (payoutRequest.proof_filename) {
                try {
                    const isR2Url = payoutRequest.proof_filename.startsWith('http');
                    
                    request.log.info({
                      entry_id: entryId,
                      proof_filename: payoutRequest.proof_filename,
                      storage_type: isR2Url ? 'R2' : 'disk',
                    }, 'Attempting to link payout proof file to cash-out entry');
                    
                    // For R2 URLs, we don't need to check file existence locally
                    // For disk files, check if file exists and get file stats
                    let fileStats = null;
                    let fileExists = false;
                    
                    if (!isR2Url) {
                      try {
                        const uploadDir = path.join(process.cwd(), 'uploads');
                        const proofPath = path.join(uploadDir, payoutRequest.proof_filename);
                        fileStats = await fs.stat(proofPath);
                        fileExists = true;
                        request.log.info({
                          proof_path: proofPath,
                          file_size: fileStats.size,
                          file_exists: true,
                        }, 'Proof file found on disk');
                      } catch (err) {
                        request.log.warn({ 
                          proof_filename: payoutRequest.proof_filename,
                          error: err.message,
                          error_code: err.code,
                        }, 'Proof file not found on disk, will create attachment record anyway');
                        fileStats = null;
                        fileExists = false;
                      }
                    } else {
                      // For R2 URLs, assume file exists (it was just uploaded)
                      fileExists = true;
                    }

                    // Determine file type and mime type from filename or URL
                    // Extract just the filename (for file_name) and keep full URL/path (for file_path)
                    const fileName = isR2Url 
                      ? payoutRequest.proof_filename.split('/').pop() 
                      : payoutRequest.proof_filename;
                    const fileNameParts = fileName.split('.');
                    const fileExtension = (fileNameParts.length > 1 ? fileNameParts.pop() : '').toLowerCase();
                    const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(fileExtension);
                    const isPdf = fileExtension === 'pdf';
                    const fileType = isImage ? 'image' : (isPdf ? 'pdf' : 'document');
                    
                    // Determine mime type
                    const mimeTypes = {
                      'jpg': 'image/jpeg',
                      'jpeg': 'image/jpeg',
                      'png': 'image/png',
                      'gif': 'image/gif',
                      'webp': 'image/webp',
                      'pdf': 'application/pdf',
                    };
                    const mimeType = mimeTypes[fileExtension] || 'application/octet-stream';

                    // Create entry attachment linking to the proof file
                    // Use file size from stats if available, otherwise use 0
                    const fileSize = fileStats ? fileStats.size : 0;
                    
                    // Store the URL (for R2) or filename (for disk) in file_path
                    // For R2 URLs, store the full URL; for disk files, store just the filename
                    // For file_name, always store just the filename (extracted from URL if needed)
                    const filePathForDb = payoutRequest.proof_filename; // Full R2 URL or local filename
                    const fileNameForDb = fileName; // Just the filename
                    
                    const attachmentResult = await client.query(
                      `INSERT INTO public.entry_attachments (
                        entry_id, book_id, file_name, file_path, file_type, file_size, mime_type
                      )
                      VALUES ($1, $2, $3, $4, $5, $6, $7)
                      RETURNING id, file_name, file_path`,
                      [
                        entryId,
                        targetBookId,
                        fileNameForDb, // Store just the filename
                        filePathForDb, // Store full R2 URL or local filename
                        fileType,
                        fileSize,
                        mimeType,
                      ]
                    );

                    if (attachmentResult.rows.length > 0) {
                      request.log.info({
                        entry_id: entryId,
                        attachment_id: attachmentResult.rows[0].id,
                        proof_filename: payoutRequest.proof_filename,
                        book_id: targetBookId,
                        file_path: proofPath,
                        file_exists: fileExists,
                        file_size: fileSize,
                      }, 'Successfully created entry attachment for payout proof');
                    } else {
                      request.log.error({
                        entry_id: entryId,
                        proof_filename: payoutRequest.proof_filename,
                      }, 'Failed to create attachment - no row returned from INSERT');
                    }
                  } catch (attachmentError) {
                    // Log error but don't fail the transaction
                    request.log.error({ 
                      err: attachmentError,
                      stack: attachmentError.stack,
                      entry_id: entryId,
                      proof_filename: payoutRequest.proof_filename,
                      book_id: targetBookId,
                    }, 'Failed to create entry attachment for payout proof');
                  }
              } else {
                request.log.warn({
                  entry_id: entryId,
                  payout_request_id: id,
                }, 'No proof_filename in payout request, skipping attachment creation');
              }

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
                book_id: targetBookId,
                wallet_id: walletId,
              }, 'Cash-Out entry created in book for accepted payout request');
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

