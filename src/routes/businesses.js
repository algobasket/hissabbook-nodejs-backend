// Businesses Routes for Admin Panel
// This is used by hissabbook-react-admin (NOT hissabbook-api-system)

const { findUserByEmail, getUserRoles, hasPermission } = require('../services/userService');
const { generateAndSaveUpiQrCode } = require('../utils/qrcode');
const { sendInviteEmail } = require('../utils/email');
const { sendInviteSms } = require('../utils/sms');
const { createShortUrl } = require('../utils/shortUrl');
const crypto = require('crypto');

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

    // Check if user has permission to view businesses
    const canView = await hasPermission(app.pg, user.id, 'businesses.view');
    if (!canView) {
      return reply.code(403).send({ message: 'Access denied. You do not have permission to view businesses.' });
    }

    // Check if user is admin
    const roles = await getUserRoles(app.pg, user.id);
    const isAdmin = roles.includes('admin');

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

      let query = `
        SELECT 
          b.id,
          b.name,
          b.description,
          b.owner_user_id,
          b.master_wallet_upi,
          b.master_wallet_qr_code,
          b.master_wallet_balance,
          b.status,
          b.business_address,
          b.staff_size,
          b.business_category,
          b.business_subcategory,
          b.business_type,
          b.business_registration_type,
          b.gst_number,
          b.business_mobile,
          b.business_email,
          b.created_at,
          b.updated_at,
          u.email as owner_email,
          ud.first_name as owner_first_name,
          ud.last_name as owner_last_name
        FROM public.businesses b
        INNER JOIN public.users u ON b.owner_user_id = u.id
        LEFT JOIN public.user_details ud ON u.id = ud.user_id
      `;

      // Admins see all businesses, regular users see only their own
      if (!isAdmin) {
        query += ' WHERE b.owner_user_id = $1';
      }

      query += ' ORDER BY b.created_at DESC';

      const result = await app.pg.query(query, isAdmin ? [] : [user.id]);

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
          masterWalletBalance: parseFloat(row.master_wallet_balance || 0),
          status: row.status,
          businessAddress: row.business_address || null,
          staffSize: row.staff_size || null,
          businessCategory: row.business_category || null,
          businessSubcategory: row.business_subcategory || null,
          businessType: row.business_type || null,
          businessRegistrationType: row.business_registration_type || null,
          gstNumber: row.gst_number || null,
          businessMobile: row.business_mobile || null,
          businessEmail: row.business_email || null,
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

      // Check if user has permission to create businesses
      const canCreate = await hasPermission(app.pg, user.id, 'businesses.create');
      if (!canCreate) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to create businesses.' });
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
        `INSERT INTO public.businesses (name, description, owner_user_id, master_wallet_upi, master_wallet_qr_code, master_wallet_balance)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, name, description, owner_user_id, master_wallet_upi, master_wallet_qr_code, master_wallet_balance, status, created_at, updated_at`,
        [name, description || null, user.id, finalUpiId, qrCodeFilename, 0.00]
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
          masterWalletBalance: parseFloat(newBusiness.master_wallet_balance || 0),
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
          businessAddress: { type: 'string' },
          staffSize: { type: 'string' },
          businessCategory: { type: 'string' },
          businessSubcategory: { type: 'string' },
          businessType: { type: 'string' },
          businessRegistrationType: { type: 'string' },
          gstNumber: { type: 'string' },
          businessMobile: { type: 'string' },
          businessEmail: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Check if user has permission to update businesses
      const canUpdate = await hasPermission(app.pg, user.id, 'businesses.update');
      if (!canUpdate) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to update businesses.' });
      }

      const { id } = request.params;
      const { 
        name, 
        description, 
        masterWalletUpi, 
        status,
        businessAddress,
        staffSize,
        businessCategory,
        businessSubcategory,
        businessType,
        businessRegistrationType,
        gstNumber,
        businessMobile,
        businessEmail,
      } = request.body;

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
      if (businessAddress !== undefined) {
        updates.push(`business_address = $${paramIndex++}`);
        params.push(businessAddress);
      }
      if (staffSize !== undefined) {
        updates.push(`staff_size = $${paramIndex++}`);
        params.push(staffSize);
      }
      if (businessCategory !== undefined) {
        updates.push(`business_category = $${paramIndex++}`);
        params.push(businessCategory);
      }
      if (businessSubcategory !== undefined) {
        updates.push(`business_subcategory = $${paramIndex++}`);
        params.push(businessSubcategory);
      }
      if (businessType !== undefined) {
        updates.push(`business_type = $${paramIndex++}`);
        params.push(businessType);
      }
      if (businessRegistrationType !== undefined) {
        updates.push(`business_registration_type = $${paramIndex++}`);
        params.push(businessRegistrationType);
      }
      if (gstNumber !== undefined) {
        updates.push(`gst_number = $${paramIndex++}`);
        params.push(gstNumber);
      }
      if (businessMobile !== undefined) {
        updates.push(`business_mobile = $${paramIndex++}`);
        params.push(businessMobile);
      }
      if (businessEmail !== undefined) {
        updates.push(`business_email = $${paramIndex++}`);
        params.push(businessEmail);
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
        RETURNING id, name, description, owner_user_id, master_wallet_upi, master_wallet_qr_code, master_wallet_balance, status, 
          business_address, staff_size, business_category, business_subcategory, business_type, 
          business_registration_type, gst_number, business_mobile, business_email, created_at, updated_at
      `;
      params.push(user.id);

      const result = await app.pg.query(query, params);
      const updatedBusiness = result.rows[0];

      return reply.send({
        success: true,
        business: {
          id: updatedBusiness.id,
          name: updatedBusiness.name,
          description: updatedBusiness.description || null,
          ownerId: updatedBusiness.owner_user_id,
          masterWalletUpi: updatedBusiness.master_wallet_upi || null,
          masterWalletQrCode: updatedBusiness.master_wallet_qr_code || null,
          masterWalletBalance: parseFloat(updatedBusiness.master_wallet_balance || 0),
          status: updatedBusiness.status,
          businessAddress: updatedBusiness.business_address || null,
          staffSize: updatedBusiness.staff_size || null,
          businessCategory: updatedBusiness.business_category || null,
          businessSubcategory: updatedBusiness.business_subcategory || null,
          businessType: updatedBusiness.business_type || null,
          businessRegistrationType: updatedBusiness.business_registration_type || null,
          gstNumber: updatedBusiness.gst_number || null,
          businessMobile: updatedBusiness.business_mobile || null,
          businessEmail: updatedBusiness.business_email || null,
          createdAt: updatedBusiness.created_at,
          updatedAt: updatedBusiness.updated_at,
        },
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

      // Check if user has permission to delete businesses
      const canDelete = await hasPermission(app.pg, user.id, 'businesses.delete');
      if (!canDelete) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to delete businesses.' });
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

  // Get invites for a business
  app.get('/businesses/:id/invites', {
    preValidation: [app.authenticate],
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      const { id } = request.params;

      // Check if business exists
      const businessResult = await app.pg.query(
        'SELECT id, name, owner_user_id FROM public.businesses WHERE id = $1',
        [id]
      );

      if (businessResult.rows.length === 0) {
        return reply.code(404).send({ message: 'Business not found' });
      }

      const business = businessResult.rows[0];

      // Check if user has access to this business (must be owner or partner)
      if (business.owner_user_id !== user.id) {
        // Check if user is a partner (owner of a book in this business)
        const partnerCheck = await app.pg.query(
          'SELECT id FROM public.books WHERE business_id = $1 AND owner_user_id = $2 LIMIT 1',
          [id, user.id]
        );
        
        if (partnerCheck.rows.length === 0) {
          return reply.code(403).send({ message: 'Access denied. You can only view invites for your own business or businesses where you are a partner.' });
        }
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

      // Check if user_invites table exists
      const userInvitesTableCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'user_invites'
        );
      `);

      const hasUserInvitesTable = userInvitesTableCheck.rows[0]?.exists;

      // Get invites for this business with user acceptance status
      let query = `
        SELECT 
          bi.id,
          bi.business_id,
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
          bi.cashbook_id,
          bi.short_url,
          ui.user_id as accepted_user_id,
          ui.status as user_invite_status,
          ui.accepted_at as user_accepted_at,
          u.email as accepted_user_email
      `;

      if (hasUserInvitesTable) {
        query += `
          FROM public.business_invites bi
          LEFT JOIN public.users inviter ON bi.invited_by = inviter.id
          LEFT JOIN public.user_invites ui ON bi.id = ui.business_invite_id
          LEFT JOIN public.users u ON ui.user_id = u.id
          WHERE bi.business_id = $1
          ORDER BY bi.created_at DESC
        `;
      } else {
        query += `
          FROM public.business_invites bi
          LEFT JOIN public.users inviter ON bi.invited_by = inviter.id
          WHERE bi.business_id = $1
          ORDER BY bi.created_at DESC
        `;
      }

      const invitesResult = await app.pg.query(query, [id]);

      const invites = invitesResult.rows.map((invite) => ({
        id: invite.id,
        businessId: invite.business_id,
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
        cashbookId: invite.cashbook_id || null,
        shortUrl: invite.short_url || null,
      }));

      return reply.send({ invites });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
      }, 'Failed to fetch business invites');
      
      return reply.code(500).send({ 
        message: 'Failed to fetch invites',
        error: error.message,
      });
    }
  });

  // Resend a business invite
  app.post('/businesses/:businessId/invites/:inviteId/resend', {
    preValidation: [app.authenticate],
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      const { businessId, inviteId } = request.params;

      // Check if business exists
      const businessResult = await app.pg.query(
        'SELECT id, name, owner_user_id FROM public.businesses WHERE id = $1',
        [businessId]
      );

      if (businessResult.rows.length === 0) {
        return reply.code(404).send({ message: 'Business not found' });
      }

      const business = businessResult.rows[0];

      // Only business owner or partner (book owner in this business) can resend invites
      if (business.owner_user_id !== user.id) {
        const partnerCheck = await app.pg.query(
          'SELECT id FROM public.books WHERE business_id = $1 AND owner_user_id = $2 LIMIT 1',
          [businessId, user.id]
        );

        if (partnerCheck.rows.length === 0) {
          return reply.code(403).send({ message: 'Access denied. You can only resend invites for your own business or businesses where you are a partner.' });
        }
      }

      // Ensure business_invites table exists
      const invitesTableCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'business_invites'
        );
      `);

      if (!invitesTableCheck.rows[0]?.exists) {
        return reply.code(404).send({ message: 'Invite system not configured' });
      }

      // Get the invite
      const inviteResult = await app.pg.query(
        `SELECT bi.*, u.email as inviter_email, ud.first_name as inviter_first_name, ud.last_name as inviter_last_name
         FROM public.business_invites bi
         LEFT JOIN public.users u ON bi.invited_by = u.id
         LEFT JOIN public.user_details ud ON u.id = ud.user_id
         WHERE bi.id = $1 AND bi.business_id = $2 AND bi.status = 'pending'`,
        [inviteId, businessId]
      );

      if (inviteResult.rows.length === 0) {
        return reply.code(404).send({ message: 'Invite not found or already accepted' });
      }

      const invite = inviteResult.rows[0];

      // Get inviter name
      const inviterName = invite.inviter_first_name && invite.inviter_last_name
        ? `${invite.inviter_first_name} ${invite.inviter_last_name}`
        : invite.inviter_email?.split('@')[0] || 'Manager';

      // Generate invite link
      let baseUrl = process.env.FRONTEND_URL || process.env.NEXT_PUBLIC_FRONTEND_URL;
      if (!baseUrl) {
        baseUrl = process.env.NODE_ENV === 'production' 
          ? 'https://hissabbook.com' 
          : 'http://localhost:3000';
      }
      const inviteIdentifier = invite.email || invite.phone || '';
      const identifierParam = invite.email ? 'email' : 'phone';
      let inviteLink = `${baseUrl}/invite?token=${invite.invite_token}&business=${businessId}&${identifierParam}=${encodeURIComponent(inviteIdentifier)}&role=${invite.role}`;
      // Add cashbookId to invite link if present
      if (invite.cashbook_id) {
        inviteLink += `&cashbook=${invite.cashbook_id}`;
      }

      // Create short URL for SMS (if phone invite)
      let shortUrlForSms = invite.short_url || null;
      if (invite.phone && !shortUrlForSms) {
        try {
          // Set expiration to match invite expiration
          const expiresAt = invite.expires_at ? new Date(invite.expires_at) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
          const shortUrlData = await createShortUrl(app.pg, inviteLink, expiresAt);
          shortUrlForSms = shortUrlData.shortUrl;
          request.log.info({ 
            shortCode: shortUrlData.shortCode, 
            originalUrl: inviteLink,
            shortUrl: shortUrlForSms
          }, 'Created short URL for SMS resend');
          
          // Store short URL in database
          await app.pg.query(
            `UPDATE public.business_invites 
             SET short_url = $1
             WHERE id = $2`,
            [shortUrlForSms, invite.id]
          );
        } catch (shortUrlError) {
          request.log.error({ err: shortUrlError }, 'Failed to create short URL for resend, will use long URL');
          // Continue with long URL if short URL creation fails
        }
      }

      // Resend invite email ONLY if a valid email is provided
      if (invite.email) {
        try {
          await sendInviteEmail({
            email: invite.email,
            businessName: business.name,
            inviteLink,
            role: invite.role,
            inviterName,
          });
          request.log.info({ email: invite.email, businessName: business.name }, 'Invite email resent successfully');
        } catch (emailError) {
          request.log.error({ err: emailError }, 'Failed to resend invite email');
          return reply.code(500).send({ 
            message: 'Failed to resend invite email. Please check email configuration.',
            error: emailError.message 
          });
        }
      }

      // Resend invite SMS ONLY if a valid phone is provided
      let smsSent = false;
      let smsErrorMessage = null;
      
      if (invite.phone) {
        request.log.info({ 
          phone: invite.phone, 
          phoneType: typeof invite.phone,
          phoneLength: invite.phone?.length,
          businessName: business.name 
        }, 'Attempting to resend invite SMS');
        
        try {
          // Use short URL for SMS if available, otherwise use long URL
          const smsLink = shortUrlForSms || inviteLink;
          await sendInviteSms({
            phone: invite.phone,
            businessName: business.name,
            inviteLink: smsLink,
            role: invite.role,
            inviterName,
          });
          smsSent = true;
          request.log.info({ 
            phone: invite.phone, 
            businessName: business.name,
            usedShortUrl: !!shortUrlForSms,
            link: smsLink
          }, 'Invite SMS resent successfully');
        } catch (smsErrorCaught) {
          smsErrorMessage = smsErrorCaught.message;
          request.log.error({ 
            err: smsErrorCaught, 
            phone: invite.phone,
            phoneType: typeof invite.phone,
            message: smsErrorCaught.message,
            stack: smsErrorCaught.stack
          }, 'Failed to resend invite SMS');
          // Don't throw - let the user know via the response message
        }
      } else {
        request.log.warn({ 
          inviteId: invite.id,
          hasPhone: !!invite.phone,
          phone: invite.phone
        }, 'No phone number found in invite for SMS resend');
      }

      // Determine success message based on what was sent
      let successMessage = 'Invite resent successfully';
      if (invite.email && invite.phone) {
        if (smsSent) {
          successMessage = 'Invite resent successfully via email and SMS';
        } else {
          successMessage = smsErrorMessage 
            ? `Invite resent via email, but SMS failed: ${smsErrorMessage}`
            : 'Invite resent via email, but SMS could not be sent';
        }
      } else if (invite.email) {
        successMessage = 'Invite resent successfully via email';
      } else if (invite.phone) {
        if (smsSent) {
          successMessage = 'Invite resent successfully via SMS';
        } else {
          // For phone-only invites, we should fail if SMS doesn't work
          return reply.code(500).send({
            success: false,
            message: smsErrorMessage 
              ? `Failed to send SMS: ${smsErrorMessage}`
              : 'Failed to send SMS. Please try again.',
            error: smsErrorMessage || 'SMS sending failed'
          });
        }
      }

      return reply.send({
        success: true,
        message: successMessage,
      });
    } catch (error) {
      request.log.error({
        err: error,
        stack: error.stack,
        message: error.message,
      }, 'Failed to resend invite');

      return reply.code(500).send({
        message: 'Failed to resend invite',
        error: error.message,
      });
    }
  });

  // Delete/cancel a business invite
  app.delete('/businesses/:businessId/invites/:inviteId', {
    preValidation: [app.authenticate],
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      const { businessId, inviteId } = request.params;

      // Check if business exists
      const businessResult = await app.pg.query(
        'SELECT id, name, owner_user_id FROM public.businesses WHERE id = $1',
        [businessId]
      );

      if (businessResult.rows.length === 0) {
        return reply.code(404).send({ message: 'Business not found' });
      }

      const business = businessResult.rows[0];

      // Only business owner or partner (book owner in this business) can delete invites
      if (business.owner_user_id !== user.id) {
        const partnerCheck = await app.pg.query(
          'SELECT id FROM public.books WHERE business_id = $1 AND owner_user_id = $2 LIMIT 1',
          [businessId, user.id]
        );

        if (partnerCheck.rows.length === 0) {
          return reply.code(403).send({ message: 'Access denied. You can only manage invites for your own business or businesses where you are a partner.' });
        }
      }

      // Ensure business_invites table exists
      const invitesTableCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'business_invites'
        );
      `);

      if (!invitesTableCheck.rows[0]?.exists) {
        return reply.code(404).send({ message: 'Invite system not configured' });
      }

      // Mark invite as rejected (treated as cancelled) - do not hard-delete
      const updateResult = await app.pg.query(
        `UPDATE public.business_invites
         SET status = 'rejected', updated_at = now()
         WHERE id = $1 AND business_id = $2
         RETURNING id, business_id, status`,
        [inviteId, businessId]
      );

      if (updateResult.rows.length === 0) {
        return reply.code(404).send({ message: 'Invite not found' });
      }

      // Also mark any related user_invites records as cancelled (best effort)
      try {
        const userInvitesTableCheck = await app.pg.query(`
          SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name = 'user_invites'
          );
        `);

        if (userInvitesTableCheck.rows[0]?.exists) {
          await app.pg.query(
            `UPDATE public.user_invites
             SET status = 'inactive', updated_at = now()
             WHERE business_invite_id = $1`,
            [inviteId]
          );
        }
      } catch (userInviteError) {
        request.log.warn({ err: userInviteError, inviteId }, 'Failed to update user_invites status when cancelling invite');
      }

      return reply.send({
        success: true,
        message: 'Invite cancelled successfully',
        invite: updateResult.rows[0],
      });
    } catch (error) {
      request.log.error({
        err: error,
        stack: error.stack,
        message: error.message,
      }, 'Failed to cancel invite');

      // Surface the underlying error message to the client to help debugging
      return reply.code(500).send({
        message: error.message || 'Failed to cancel invite',
        error: error.message,
      });
    }
  });

  // Invite user to business (send email with invite link)
  app.post('/businesses/:id/invites', {
    preValidation: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['role'],
        properties: {
          email: { type: 'string', format: 'email' },
          phone: { type: 'string' },
          role: { type: 'string', enum: ['Staff', 'Partner'] },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Check if user has permission to invite members
      const canInvite = await hasPermission(app.pg, user.id, 'businesses.update');
      if (!canInvite) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to invite members.' });
      }

      const { id } = request.params;
      let { email, phone, role, cashbookId } = request.body;

      // Validate that either email or phone is provided
      if (!email && !phone) {
        return reply.code(400).send({ message: 'Either email or phone is required' });
      }

      // Validate role-specific requirements
      if (role === 'Staff' && !cashbookId) {
        return reply.code(400).send({ message: 'Cashbook ID is required when inviting Staff members' });
      }
      if (role === 'Partner' && !id) {
        return reply.code(400).send({ message: 'Business ID is required when inviting Partners' });
      }

      // Normalize: if only phone is provided, ensure email is null/undefined (not empty string or phone value)
      // If only email is provided, ensure phone is null/undefined
      if (phone && !email) {
        email = null; // Explicitly set to null when only phone is provided
      }
      if (email && !phone) {
        phone = null; // Explicitly set to null when only email is provided
      }

      // Validate email format if email is provided
      if (email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
          return reply.code(400).send({ message: 'Invalid email format' });
        }
      }

      // For Staff invites, verify cashbook exists and belongs to the business
      if (role === 'Staff' && cashbookId) {
        const cashbookCheck = await app.pg.query(
          'SELECT id, business_id FROM public.books WHERE id = $1',
          [cashbookId]
        );
        
        if (cashbookCheck.rows.length === 0) {
          return reply.code(404).send({ message: 'Cashbook not found' });
        }
        
        const cashbook = cashbookCheck.rows[0];
        // Verify cashbook belongs to the business (or allow if cashbook has no business_id for flexibility)
        if (cashbook.business_id && cashbook.business_id !== id) {
          return reply.code(400).send({ message: 'Cashbook does not belong to this business' });
        }
      }

      // Check if business exists
      const businessResult = await app.pg.query(
        'SELECT id, name, owner_user_id FROM public.businesses WHERE id = $1',
        [id]
      );

      if (businessResult.rows.length === 0) {
        return reply.code(404).send({ message: 'Business not found' });
      }

      const business = businessResult.rows[0];

      // Check if user has access to this business (must be owner or partner)
      if (business.owner_user_id !== user.id) {
        // Check if user is a partner (owner of a book in this business)
        const partnerCheck = await app.pg.query(
          'SELECT id FROM public.books WHERE business_id = $1 AND owner_user_id = $2 LIMIT 1',
          [id, user.id]
        );
        
        if (partnerCheck.rows.length === 0) {
          return reply.code(403).send({ message: 'Access denied. You can only invite members to your own business or businesses where you are a partner.' });
        }
      }

      // Get inviter name
      const inviterDetails = await app.pg.query(
        `SELECT ud.first_name, ud.last_name, u.email
         FROM public.users u
         LEFT JOIN public.user_details ud ON u.id = ud.user_id
         WHERE u.id = $1`,
        [user.id]
      );

      const inviter = inviterDetails.rows[0];
      const inviterName = [inviter?.first_name, inviter?.last_name].filter(Boolean).join(' ').trim() || inviter?.email?.split('@')[0] || 'Someone';

      // Generate invite token (simple hash for now)
      // Use normalized email/phone values (null when not provided)
      const inviteData = {
        businessId: id,
        email: email ? email.trim() : null, // Explicitly null if not provided
        phone: phone ? phone.trim() : null, // Explicitly null if not provided
        role: role,
        invitedBy: user.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      };

      const inviteToken = crypto.createHash('sha256')
        .update(JSON.stringify(inviteData) + Date.now() + Math.random())
        .digest('hex')
        .substring(0, 32);

      // Store invite in database (create invites table if needed)
      // For now, we'll check if the table exists
      const invitesTableCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'business_invites'
        );
      `);

      // Generate invite link first (needed for short URL creation)
      // Get base URL from environment or use production default
      let baseUrl = process.env.FRONTEND_URL || process.env.NEXT_PUBLIC_FRONTEND_URL;
      if (!baseUrl) {
        baseUrl = process.env.NODE_ENV === 'production' 
          ? 'https://hissabbook.com' 
          : 'http://localhost:3000';
      }
      // For invite link, use email if available, otherwise use phone (but don't mix them)
      // Use normalized values from inviteData to ensure we don't use phone as email
      const inviteIdentifier = inviteData.email || inviteData.phone || '';
      const identifierParam = inviteData.email ? 'email' : 'phone';
      let inviteLink = `${baseUrl}/invite?token=${inviteToken}&business=${id}&${identifierParam}=${encodeURIComponent(inviteIdentifier)}&role=${role}`;
      // Add cashbookId to invite link if provided (for Staff invites from specific books)
      if (cashbookId) {
        inviteLink += `&cashbook=${cashbookId}`;
      }

      // Create short URL for SMS (if phone invite)
      let shortUrlForSms = null;
      if (inviteData.phone) {
        try {
          // Set expiration to match invite expiration (7 days)
          const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
          request.log.info({ inviteLink, expiresAt }, 'Attempting to create short URL');
          const shortUrlData = await createShortUrl(app.pg, inviteLink, expiresAt);
          shortUrlForSms = shortUrlData.shortUrl;
          request.log.info({ 
            shortCode: shortUrlData.shortCode, 
            originalUrl: inviteLink,
            shortUrl: shortUrlForSms,
            shortUrlId: shortUrlData.id
          }, 'Successfully created short URL for SMS invite');
        } catch (shortUrlError) {
          request.log.error({ 
            err: shortUrlError,
            message: shortUrlError.message,
            stack: shortUrlError.stack,
            inviteLink
          }, 'Failed to create short URL, will use long URL');
          // Continue with long URL if short URL creation fails
        }
      }

      if (invitesTableCheck.rows[0]?.exists) {
        // Check if an invite already exists for this business, email, and phone combination
        // Use normalized values to ensure proper matching
        const existingInvite = await app.pg.query(
          `SELECT id FROM public.business_invites 
           WHERE business_id = $1 
           AND (email = $2 OR ($2 IS NULL AND email IS NULL))
           AND (phone = $3 OR ($3 IS NULL AND phone IS NULL))
           AND role = $4
           LIMIT 1`,
          [id, inviteData.email, inviteData.phone, role]
        );

        if (existingInvite.rows.length > 0) {
          // Update existing invite (include cashbook_id and short_url if provided)
          await app.pg.query(
            `UPDATE public.business_invites 
             SET invite_token = $1, expires_at = $2, status = 'pending', updated_at = now(), cashbook_id = $4, email = $5, phone = $6, short_url = COALESCE($7, short_url)
             WHERE id = $3`,
            [inviteToken, inviteData.expiresAt, existingInvite.rows[0].id, cashbookId || null, inviteData.email, inviteData.phone, shortUrlForSms]
          );
        } else {
          // Insert new invite record (include cashbook_id and short_url if provided)
          // Use normalized values from inviteData to ensure email/phone are properly null when not provided
          await app.pg.query(
            `INSERT INTO public.business_invites (business_id, email, phone, role, invite_token, invited_by, expires_at, status, cashbook_id, short_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9)`,
            [id, inviteData.email, inviteData.phone, role, inviteToken, user.id, inviteData.expiresAt, cashbookId || null, shortUrlForSms]
          );
        }
      }

      // Send invite email ONLY if a valid email is provided (not phone)
      if (inviteData.email) {
        try {
          await sendInviteEmail({
            email: inviteData.email, // Use normalized email value
            businessName: business.name,
            inviteLink,
            role,
            inviterName,
          });
        } catch (emailError) {
          request.log.error({ err: emailError }, 'Failed to send invite email');
          return reply.code(500).send({ 
            message: 'Failed to send invite email. Please check email configuration.',
            error: emailError.message 
          });
        }
      }

      // Send invite SMS ONLY if a valid phone is provided (not email)
      if (inviteData.phone) {
        try {
          // Use short URL for SMS if available, otherwise use long URL
          const smsLink = shortUrlForSms || inviteLink;
          await sendInviteSms({
            phone: inviteData.phone, // Use normalized phone value
            businessName: business.name,
            inviteLink: smsLink,
            role,
            inviterName,
          });
          request.log.info({ 
            phone, 
            businessName: business.name,
            usedShortUrl: !!shortUrlForSms,
            link: smsLink
          }, 'Invite SMS sent successfully');
        } catch (smsError) {
          request.log.error({ err: smsError, phone }, 'Failed to send invite SMS');
          // Don't fail the entire request if SMS fails - the invite is still created
          // Just log the error and continue
        }
      }

      // Determine success message based on what was sent
      // Use normalized values from inviteData
      let successMessage = 'Invite created successfully';
      if (inviteData.email && inviteData.phone) {
        successMessage = 'Invite sent successfully via email and SMS';
      } else if (inviteData.email) {
        successMessage = 'Invite sent successfully via email';
      } else if (inviteData.phone) {
        successMessage = 'Invite sent successfully via SMS';
      }

      return reply.code(201).send({
        success: true,
        message: successMessage,
        invite: {
          token: inviteToken,
          inviteLink,
          email: inviteData.email, // Use normalized values
          phone: inviteData.phone, // Use normalized values
          role,
          businessId: id,
          businessName: business.name,
        },
      });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
        code: error.code,
        detail: error.detail
      }, 'Failed to send business invite');
      
      const errorMessage = error.detail || error.message || 'Failed to send invite';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Add existing user to business team
  app.post('/businesses/:id/members', {
    preValidation: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['userId', 'role'],
        properties: {
          userId: { type: 'string', format: 'uuid' },
          role: { type: 'string', enum: ['Staff', 'Partner'] },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Check if user has permission to add members
      const canAdd = await hasPermission(app.pg, user.id, 'businesses.update');
      if (!canAdd) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to add members.' });
      }

      const { id } = request.params;
      const { userId, role } = request.body;

      // Check if business exists
      const businessResult = await app.pg.query(
        'SELECT id, name, owner_user_id FROM public.businesses WHERE id = $1',
        [id]
      );

      if (businessResult.rows.length === 0) {
        return reply.code(404).send({ message: 'Business not found' });
      }

      const business = businessResult.rows[0];

      // Check if user has access to this business
      if (business.owner_user_id !== user.id) {
        const partnerCheck = await app.pg.query(
          'SELECT id FROM public.books WHERE business_id = $1 AND owner_user_id = $2 LIMIT 1',
          [id, user.id]
        );
        
        if (partnerCheck.rows.length === 0) {
          return reply.code(403).send({ message: 'Access denied. You can only add members to your own business or businesses where you are a partner.' });
        }
      }

      // Check if user to be added exists
      const userToAddResult = await app.pg.query(
        'SELECT id, email FROM public.users WHERE id = $1',
        [userId]
      );

      if (userToAddResult.rows.length === 0) {
        return reply.code(404).send({ message: 'User not found' });
      }

      const userToAdd = userToAddResult.rows[0];

      // If role is Partner, create a book for them (they need to own a book to be a partner)
      // If role is Staff, they'll be added to books individually
      // For now, we'll just mark them as added to the business
      // In a full implementation, you might want to:
      // - Create a business_users table to track business members
      // - Or create a default book for Partners
      // - Or add them to all existing books

      return reply.code(201).send({
        success: true,
        message: `User added to business as ${role}`,
        member: {
          userId: userToAdd.id,
          email: userToAdd.email,
          role,
          businessId: id,
          businessName: business.name,
        },
      });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
        code: error.code,
        detail: error.detail
      }, 'Failed to add business member');
      
      const errorMessage = error.detail || error.message || 'Failed to add member';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Note: Invite routes have been moved to src/routes/invites.js
}

module.exports = businessesRoutes;


