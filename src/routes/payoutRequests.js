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

const { findUserByEmail, getUserRoles } = require('../services/userService');

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

      // Check if user is admin
      const roles = await getUserRoles(app.pg, user.id);
      const isAdmin = roles.includes('admin');

      if (!isAdmin) {
        return reply.code(403).send({ message: 'Access denied. Admin role required.' });
      }

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
      if (status && status !== 'all') {
        query += ' WHERE pr.status = $1';
        params.push(status);
      }

      query += ' ORDER BY pr.created_at DESC';

      const result = await app.pg.query(query, params.length > 0 ? params : undefined);

      const payoutRequests = result.rows.map((row) => {
        const fullName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || row.user_email?.split('@')[0] || 'Unknown';
        // Generate reference from ID and timestamp
        const shortId = row.id.replace(/-/g, '').substring(0, 8).toUpperCase();
        const year = new Date(row.created_at).getFullYear();
        const reference = `REQ-${year}-${shortId}`;

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

      // Check if user is admin
      const roles = await getUserRoles(app.pg, user.id);
      const isAdmin = roles.includes('admin');

      if (!isAdmin) {
        return reply.code(403).send({ message: 'Access denied. Admin role required.' });
      }

      const { id } = request.params;
      const { status, notes } = request.body;

      // Check if request exists and is pending, get full details
      const existing = await app.pg.query(
        `SELECT id, status, amount, utr, remarks, user_id, book_id, created_at 
         FROM public.payout_requests 
         WHERE id = $1`,
        [id]
      );

      if (existing.rows.length === 0) {
        return reply.code(404).send({ message: 'Payout request not found' });
      }

      if (existing.rows[0].status !== 'pending') {
        return reply.code(400).send({ message: 'Request is not in pending status' });
      }

      const payoutRequest = existing.rows[0];

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

        // If accepted, create a Cash-Out transaction entry
        if (status === 'accepted') {
          // If no user_id, skip transaction creation but still update status
          if (!payoutRequest.user_id) {
            request.log.warn({ payout_request_id: id }, 'Payout request accepted but no user_id, skipping transaction creation');
          } else {
          // Use book_id from payout request if available, otherwise get user's default book
          let bookId = payoutRequest.book_id;
          
          if (!bookId) {
            // Get user's default book (first book owned by the user)
            const bookResult = await client.query(
              `SELECT id FROM public.books 
               WHERE owner_user_id = $1 
               ORDER BY created_at ASC 
               LIMIT 1`,
              [payoutRequest.user_id]
            );

            if (bookResult.rows.length > 0) {
              bookId = bookResult.rows[0].id;
            } else {
              // If user has no book, get any book (fallback)
              const anyBookResult = await client.query(
                'SELECT id FROM public.books ORDER BY created_at ASC LIMIT 1'
              );
              if (anyBookResult.rows.length > 0) {
                bookId = anyBookResult.rows[0].id;
              }
            }
          }

          // Get user's wallet if exists
          const walletResult = await client.query(
            'SELECT id FROM public.user_wallets WHERE user_id = $1',
            [payoutRequest.user_id]
          );
          const walletId = walletResult.rows.length > 0 ? walletResult.rows[0].id : null;

          // Create Cash-Out transaction entry
          const transactionDescription = `Payout Request: ${payoutRequest.utr} - ${payoutRequest.remarks}`;
          
          await client.query(
            `INSERT INTO public.transactions 
             (book_id, user_id, wallet_id, type, status, amount, currency_code, description, metadata, occurred_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
            [
              bookId,
              payoutRequest.user_id,
              walletId,
              'debit', // Cash-Out is a debit transaction
              'completed',
              payoutRequest.amount,
              'INR',
              transactionDescription,
              JSON.stringify({
                payout_request_id: id,
                utr: payoutRequest.utr,
                approved_by: user.id,
                approved_at: new Date().toISOString(),
                notes: notes,
              }),
            ]
          );

          // Update wallet balance if wallet exists (decrease balance for cash-out)
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
              book_id: bookId,
              wallet_id: walletId,
            }, 'Cash-Out transaction created for accepted payout request');
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

