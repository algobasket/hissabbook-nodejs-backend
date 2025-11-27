const crypto = require('crypto');
const { verifyPassword, hashPassword } = require('../utils/password');
const { findUserByEmail, createUser, getUserRoles, getUserDetails, updateUserDetails } = require('../services/userService');
const { saveImageToDisk, deleteImageFromDisk } = require('../utils/fileUpload');
const { sendVerificationEmail } = require('../utils/email');

async function authRoutes(app) {
  app.post('/register', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 8 },
          firstName: { type: 'string', minLength: 1 },
          lastName: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { email, password, firstName, lastName } = request.body;
    const existing = await findUserByEmail(app.pg, email);

    if (existing) {
      return reply.code(409).send({ message: 'Email already registered' });
    }

    const user = await createUser(app.pg, { email, password, firstName, lastName });

    return reply.code(201).send({
      user: {
        id: user.id,
        email: user.email,
        status: user.status,
        createdAt: user.created_at,
      },
    });
  });

  app.post('/login', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { email, password } = request.body;

    const user = await findUserByEmail(app.pg, email);

    if (!user) {
      return reply.code(401).send({ message: 'Invalid email or password' });
    }

    const isValid = await verifyPassword(password, user.password_hash);

    if (!isValid) {
      return reply.code(401).send({ message: 'Invalid email or password' });
    }

    await app.pg.query(
      'UPDATE public.users SET last_login_at = now(), updated_at = now() WHERE id = $1',
      [user.id],
    );

    // Get user roles
    const roles = await getUserRoles(app.pg, user.id);
    const primaryRole = roles[0] || null;

    const token = app.jwt.sign({
      sub: user.id,
      email: user.email,
      status: user.status,
      roles: roles,
      role: primaryRole,
    });

    return reply.send({
      token,
      user: {
        id: user.id,
        email: user.email,
        status: user.status,
        roles: roles,
        role: primaryRole,
      },
    });
  });

  app.post('/logout', { preValidation: [app.authenticate] }, async (request, reply) => {
    // For stateless JWT auth we simply rely on client to discard token.
    return reply.send({ success: true });
  });

  app.get('/me', { preValidation: [app.authenticate] }, async (request) => {
    const user = await findUserByEmail(app.pg, request.user.email);
    const roles = await getUserRoles(app.pg, user.id);
    const primaryRole = roles[0] || null;

    return {
      user: {
        id: user.id,
        email: user.email,
        status: user.status,
        roles: roles,
        role: primaryRole,
        createdAt: user.created_at,
        lastLoginAt: user.last_login_at,
      },
    };
  });

  // Refresh token endpoint - generates a new token with extended expiration
  app.post('/refresh-token', { preValidation: [app.authenticate] }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Get user roles
      const roles = await getUserRoles(app.pg, user.id);
      const primaryRole = roles[0] || null;

      // Generate new token
      const token = app.jwt.sign({
        sub: user.id,
        email: user.email,
        status: user.status,
        roles: roles,
        role: primaryRole,
      });

      return reply.send({
        token,
        user: {
          id: user.id,
          email: user.email,
          status: user.status,
          roles: roles,
          role: primaryRole,
        },
      });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to refresh token');
      return reply.code(500).send({ message: 'Failed to refresh token' });
    }
  });

  // Get user account details
  app.get('/account-details', { preValidation: [app.authenticate] }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      const userDetails = await getUserDetails(app.pg, user.id);
      const roles = await getUserRoles(app.pg, user.id);
      const primaryRole = roles[0] || 'managers';

      if (!userDetails) {
        return reply.send({
          email: user.email,
          name: null,
          firstName: null,
          lastName: null,
          gstin: null,
          phone: null,
          upiId: null,
          upiQrCode: null,
          role: primaryRole,
          roles: roles,
          isEmailVerified: user.is_email_verified || false,
        });
      }

      // Parse metadata if it's a string
      let metadata = {};
      if (userDetails.metadata) {
        if (typeof userDetails.metadata === 'object') {
          metadata = userDetails.metadata;
        } else {
          try {
            metadata = typeof userDetails.metadata === 'string' ? JSON.parse(userDetails.metadata) : {};
          } catch {
            metadata = {};
          }
        }
      }

      const fullName = [userDetails.first_name, userDetails.last_name].filter(Boolean).join(' ').trim() || null;

      return reply.send({
        email: user.email,
        name: fullName,
        firstName: userDetails.first_name || null,
        lastName: userDetails.last_name || null,
        gstin: metadata.gstin || null,
        phone: userDetails.phone || null,
        upiId: userDetails.upi_id || null,
        upiQrCode: userDetails.upi_qr_code || null,
        role: primaryRole,
        roles: roles,
        isEmailVerified: user.is_email_verified || false,
      });
    } catch (error) {
      request.log.error({ err: error, stack: error.stack }, 'Failed to fetch account details');
      return reply.code(500).send({ 
        message: 'Failed to fetch account details',
        error: error.message 
      });
    }
  });

  // Update user account details
  app.put('/account-details', {
    preValidation: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          firstName: { type: 'string' },
          lastName: { type: 'string' },
          gstin: { type: 'string' },
          phone: { type: 'string' },
          upiId: { type: 'string' },
          upiQrCode: { type: 'string' }, // Base64 image string
        },
      },
    },
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Check if user has permission to edit account info
      const { hasPermission } = require('../services/userService');
      const canEditInfo = await hasPermission(app.pg, user.id, 'accounts.edit_info');
      if (!canEditInfo) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to edit account information.' });
      }

      const { name, firstName, lastName, gstin, phone, upiId, upiQrCode } = request.body;

      // Get existing details to check for old QR code
      const existing = await getUserDetails(app.pg, user.id);
      let qrCodeFilename = existing?.upi_qr_code || null;

      // Handle QR code upload
      if (upiQrCode !== undefined) {
        try {
          // If a new QR code is provided, save it
          if (upiQrCode && upiQrCode.trim() !== '') {
            // Delete old QR code if it exists
            if (qrCodeFilename) {
              await deleteImageFromDisk(qrCodeFilename);
            }
            // Save new QR code
            qrCodeFilename = await saveImageToDisk(upiQrCode, 'qr-code');
          } else if (upiQrCode === null || upiQrCode === '') {
            // If QR code is explicitly set to empty, delete the old one
            if (qrCodeFilename) {
              await deleteImageFromDisk(qrCodeFilename);
              qrCodeFilename = null;
            }
          }
        } catch (error) {
          request.log.error({ err: error }, 'Failed to save QR code image');
          return reply.code(400).send({ message: `Failed to save QR code: ${error.message}` });
        }
      }

      // If name is provided, split it into first and last name
      let finalFirstName = firstName;
      let finalLastName = lastName;

      if (name && !firstName && !lastName) {
        const nameParts = name.trim().split(/\s+/);
        finalFirstName = nameParts[0] || null;
        finalLastName = nameParts.slice(1).join(' ') || null;
      }

      const updatedDetails = await updateUserDetails(app.pg, user.id, {
        firstName: finalFirstName,
        lastName: finalLastName,
        gstin,
        phone,
        upiId,
        upiQrCode: qrCodeFilename,
      });

      if (!updatedDetails) {
        return reply.code(500).send({ message: 'Failed to update account details' });
      }

      // Parse metadata if it's a string
      let metadata = {};
      if (updatedDetails.metadata) {
        if (typeof updatedDetails.metadata === 'object') {
          metadata = updatedDetails.metadata;
        } else {
          try {
            metadata = typeof updatedDetails.metadata === 'string' ? JSON.parse(updatedDetails.metadata) : {};
          } catch {
            metadata = {};
          }
        }
      }

      const fullName = [updatedDetails.first_name, updatedDetails.last_name].filter(Boolean).join(' ').trim() || null;

      // Get user roles
      const roles = await getUserRoles(app.pg, user.id);
      const primaryRole = roles[0] || 'managers';

      return reply.send({
        success: true,
        accountDetails: {
          email: user.email,
          name: fullName,
          firstName: updatedDetails.first_name || null,
          lastName: updatedDetails.last_name || null,
          gstin: metadata.gstin || null,
          phone: updatedDetails.phone || null,
          upiId: updatedDetails.upi_id || null,
          upiQrCode: updatedDetails.upi_qr_code || null,
          role: primaryRole,
          roles: roles,
        },
      });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to update account details');
      return reply.code(500).send({ message: 'Failed to update account details', error: error.message });
    }
  });

  // Change password endpoint
  app.put('/change-password', {
    preValidation: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['newPassword'],
        properties: {
          newPassword: { type: 'string', minLength: 8 },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Check if user has permission to change password
      const { hasPermission } = require('../services/userService');
      const canChangePassword = await hasPermission(app.pg, user.id, 'accounts.change_password');
      if (!canChangePassword) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to change password.' });
      }

      const { newPassword } = request.body;

      // Hash new password
      const passwordHash = await hashPassword(newPassword);

      // Update password
      await app.pg.query(
        'UPDATE public.users SET password_hash = $1, updated_at = now() WHERE id = $2',
        [passwordHash, user.id]
      );

      return reply.send({
        success: true,
        message: 'Password changed successfully',
      });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to change password');
      return reply.code(500).send({
        message: 'Failed to change password',
        error: error.message,
      });
    }
  });

  // Change email endpoint
  app.put('/change-email', {
    preValidation: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['newEmail'],
        properties: {
          newEmail: { type: 'string', format: 'email' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Check if user has permission to change email
      const { hasPermission } = require('../services/userService');
      const canChangeEmail = await hasPermission(app.pg, user.id, 'accounts.change_email');
      if (!canChangeEmail) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to change email.' });
      }

      const { newEmail } = request.body;

      // Check if email is already in use
      const existingUser = await findUserByEmail(app.pg, newEmail);
      if (existingUser && existingUser.id !== user.id) {
        return reply.code(409).send({ message: 'Email already in use' });
      }

      // Update email
      await app.pg.query(
        'UPDATE public.users SET email = $1, updated_at = now() WHERE id = $2',
        [newEmail.toLowerCase(), user.id]
      );

      return reply.send({
        success: true,
        message: 'Email changed successfully',
      });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to change email');
      return reply.code(500).send({
        message: 'Failed to change email',
        error: error.message,
      });
    }
  });

  // Send verification email endpoint
  app.post('/send-verification-email', {
    preValidation: [app.authenticate],
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Check if user has permission to verify email
      const { hasPermission } = require('../services/userService');
      const canVerifyEmail = await hasPermission(app.pg, user.id, 'accounts.verify_email');
      if (!canVerifyEmail) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to verify email.' });
      }

      if (user.is_email_verified) {
        return reply.code(400).send({ message: 'Email is already verified' });
      }

      // Generate verification token
      const verificationToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24); // Token expires in 24 hours

      // Store verification token in database (you might want to create a separate table for this)
      // For now, we'll store it in a simple way - you could create an email_verifications table
      await app.pg.query(
        `INSERT INTO public.email_verifications (user_id, token, expires_at, created_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id) DO UPDATE
         SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at, created_at = now()`,
        [user.id, verificationToken, expiresAt]
      );

      // Generate verification link
      const baseUrl = process.env.FRONTEND_URL || process.env.NEXT_PUBLIC_FRONTEND_URL || 'http://localhost:3000';
      const verificationLink = `${baseUrl}/verify-email?token=${verificationToken}`;

      // Send verification email
      await sendVerificationEmail({
        email: user.email,
        verificationLink,
      });

      return reply.send({
        success: true,
        message: 'Verification email sent successfully',
      });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to send verification email');
      return reply.code(500).send({
        message: 'Failed to send verification email',
        error: error.message,
      });
    }
  });

  // Verify email endpoint
  app.get('/verify-email', {
    schema: {
      querystring: {
        type: 'object',
        required: ['token'],
        properties: {
          token: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const { token } = request.query;

      // Find verification token
      const result = await app.pg.query(
        `SELECT user_id, expires_at FROM public.email_verifications WHERE token = $1`,
        [token]
      );

      if (result.rows.length === 0) {
        return reply.code(400).send({ message: 'Invalid verification token' });
      }

      const verification = result.rows[0];
      const now = new Date();

      if (now > verification.expires_at) {
        return reply.code(400).send({ message: 'Verification token has expired' });
      }

      // Update user's email verification status
      await app.pg.query(
        'UPDATE public.users SET is_email_verified = true, updated_at = now() WHERE id = $1',
        [verification.user_id]
      );

      // Delete used verification token
      await app.pg.query(
        'DELETE FROM public.email_verifications WHERE token = $1',
        [token]
      );

      return reply.send({
        success: true,
        message: 'Email verified successfully',
      });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to verify email');
      return reply.code(500).send({
        message: 'Failed to verify email',
        error: error.message,
      });
    }
  });
}

module.exports = authRoutes;

