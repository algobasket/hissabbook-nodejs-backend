// Businesses Routes for Admin Panel
// This is used by hissabbook-react-admin (NOT hissabbook-api-system)

const { findUserByEmail, getUserRoles } = require('../services/userService');
const { generateAndSaveUpiQrCode } = require('../utils/qrcode');

async function businessesRoutes(app) {
  // Get all businesses for the authenticated admin
  app.get('/businesses', {
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

      // Check if businesses table exists
      const tableCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'businesses'
        );
      `);

      if (!tableCheck.rows[0]?.exists) {
        return reply.send({ businesses: [] });
      }

      const query = `
        SELECT 
          b.id,
          b.name,
          b.description,
          b.owner_user_id,
          b.master_wallet_upi,
          b.master_wallet_qr_code,
          b.status,
          b.created_at,
          b.updated_at,
          u.email as owner_email,
          ud.first_name as owner_first_name,
          ud.last_name as owner_last_name
        FROM public.businesses b
        INNER JOIN public.users u ON b.owner_user_id = u.id
        LEFT JOIN public.user_details ud ON u.id = ud.user_id
        WHERE b.owner_user_id = $1
        ORDER BY b.created_at DESC
      `;

      const result = await app.pg.query(query, [user.id]);

      const businesses = result.rows.map((row) => {
        const ownerFullName = [row.owner_first_name, row.owner_last_name]
          .filter(Boolean)
          .join(' ')
          .trim() || row.owner_email?.split('@')[0] || 'Unknown';

        return {
          id: row.id,
          name: row.name,
          description: row.description || null,
          ownerId: row.owner_user_id,
          ownerEmail: row.owner_email,
          ownerName: ownerFullName,
          masterWalletUpi: row.master_wallet_upi || null,
          masterWalletQrCode: row.master_wallet_qr_code || null,
          status: row.status,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      });

      return reply.send({ businesses });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
        code: error.code,
        detail: error.detail
      }, 'Failed to fetch businesses');
      
      const errorMessage = error.detail || error.message || 'Failed to fetch businesses';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Create new business
  app.post('/businesses', {
    preValidation: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1 },
          description: { type: 'string' },
          masterWalletUpi: { type: 'string' },
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

      const { name, description, masterWalletUpi } = request.body;

      // Generate UPI ID if not provided (format: businessname@hissabbook)
      let finalUpiId = masterWalletUpi;
      let qrCodeFilename = null;

      if (!finalUpiId) {
        // Generate UPI ID from business name
        const businessNameSlug = name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '')
          .substring(0, 20);
        finalUpiId = `${businessNameSlug}@hissabbook`;
      }

      // Generate QR code for master wallet UPI
      if (finalUpiId) {
        try {
          qrCodeFilename = await generateAndSaveUpiQrCode(finalUpiId, name);
        } catch (qrError) {
          request.log.warn({ err: qrError }, 'Failed to generate QR code for business UPI');
        }
      }

      // Create business
      const result = await app.pg.query(
        `INSERT INTO public.businesses (name, description, owner_user_id, master_wallet_upi, master_wallet_qr_code)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, description, owner_user_id, master_wallet_upi, master_wallet_qr_code, status, created_at, updated_at`,
        [name, description || null, user.id, finalUpiId, qrCodeFilename]
      );

      const newBusiness = result.rows[0];

      // Get owner details
      const ownerDetails = await app.pg.query(
        `SELECT u.email, ud.first_name, ud.last_name
         FROM public.users u
         LEFT JOIN public.user_details ud ON u.id = ud.user_id
         WHERE u.id = $1`,
        [user.id]
      );

      const owner = ownerDetails.rows[0];
      const ownerFullName = [owner?.first_name, owner?.last_name]
        .filter(Boolean)
        .join(' ')
        .trim() || owner?.email?.split('@')[0] || 'Unknown';

      return reply.code(201).send({
        success: true,
        business: {
          id: newBusiness.id,
          name: newBusiness.name,
          description: newBusiness.description || null,
          ownerId: newBusiness.owner_user_id,
          ownerEmail: owner?.email,
          ownerName: ownerFullName,
          masterWalletUpi: newBusiness.master_wallet_upi,
          masterWalletQrCode: newBusiness.master_wallet_qr_code,
          status: newBusiness.status,
          createdAt: newBusiness.created_at,
          updatedAt: newBusiness.updated_at,
        },
      });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
        code: error.code,
        detail: error.detail
      }, 'Failed to create business');
      
      const errorMessage = error.detail || error.message || 'Failed to create business';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Update business
  app.patch('/businesses/:id', {
    preValidation: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1 },
          description: { type: 'string' },
          masterWalletUpi: { type: 'string' },
          status: { type: 'string', enum: ['active', 'inactive'] },
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
      const { name, description, masterWalletUpi, status } = request.body;

      // Check if business exists and belongs to user
      const existing = await app.pg.query(
        'SELECT id, name, master_wallet_upi FROM public.businesses WHERE id = $1 AND owner_user_id = $2',
        [id, user.id]
      );

      if (existing.rows.length === 0) {
        return reply.code(404).send({ message: 'Business not found' });
      }

      const business = existing.rows[0];
      let qrCodeFilename = business.master_wallet_qr_code;
      let finalUpiId = masterWalletUpi || business.master_wallet_upi;

      // If UPI ID changed, regenerate QR code
      if (masterWalletUpi && masterWalletUpi !== business.master_wallet_upi) {
        try {
          qrCodeFilename = await generateAndSaveUpiQrCode(masterWalletUpi, name || business.name);
        } catch (qrError) {
          request.log.warn({ err: qrError }, 'Failed to generate QR code for business UPI');
        }
      }

      // Build update query dynamically
      const updates = [];
      const params = [];
      let paramIndex = 1;

      if (name !== undefined) {
        updates.push(`name = $${paramIndex++}`);
        params.push(name);
      }
      if (description !== undefined) {
        updates.push(`description = $${paramIndex++}`);
        params.push(description);
      }
      if (masterWalletUpi !== undefined) {
        updates.push(`master_wallet_upi = $${paramIndex++}`);
        params.push(finalUpiId);
        if (qrCodeFilename) {
          updates.push(`master_wallet_qr_code = $${paramIndex++}`);
          params.push(qrCodeFilename);
        }
      }
      if (status !== undefined) {
        updates.push(`status = $${paramIndex++}`);
        params.push(status);
      }

      if (updates.length === 0) {
        return reply.code(400).send({ message: 'No fields to update' });
      }

      updates.push(`updated_at = now()`);
      params.push(id);

      const query = `
        UPDATE public.businesses
        SET ${updates.join(', ')}
        WHERE id = $${paramIndex} AND owner_user_id = $${paramIndex + 1}
        RETURNING id, name, description, owner_user_id, master_wallet_upi, master_wallet_qr_code, status, created_at, updated_at
      `;
      params.push(user.id);

      const result = await app.pg.query(query, params);

      return reply.send({
        success: true,
        business: result.rows[0],
      });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
        code: error.code,
        detail: error.detail
      }, 'Failed to update business');
      
      const errorMessage = error.detail || error.message || 'Failed to update business';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Delete business (admin only)
  app.delete('/businesses/:id', {
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

      // Check if business exists
      const existing = await app.pg.query(
        'SELECT id, name, master_wallet_qr_code FROM public.businesses WHERE id = $1',
        [id]
      );

      if (existing.rows.length === 0) {
        return reply.code(404).send({ message: 'Business not found' });
      }

      const business = existing.rows[0];

      // Delete QR code file if it exists
      if (business.master_wallet_qr_code) {
        try {
          const fs = require('fs').promises;
          const path = require('path');
          const uploadDir = path.join(process.cwd(), 'uploads');
          const qrCodePath = path.join(uploadDir, business.master_wallet_qr_code);
          await fs.unlink(qrCodePath).catch(() => {
            // File doesn't exist or can't be deleted - that's okay
          });
        } catch (qrError) {
          request.log.warn({ err: qrError }, 'Failed to delete QR code file');
        }
      }

      // Delete business (cascade will handle related records)
      await app.pg.query('DELETE FROM public.businesses WHERE id = $1', [id]);

      return reply.send({
        success: true,
        message: 'Business deleted successfully',
      });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
        code: error.code,
        detail: error.detail
      }, 'Failed to delete business');
      
      const errorMessage = error.detail || error.message || 'Failed to delete business';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });
}

module.exports = businessesRoutes;


