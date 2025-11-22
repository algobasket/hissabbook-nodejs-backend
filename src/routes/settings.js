// Settings Routes for system-wide settings

const { findUserByEmail, getUserRoles } = require('../services/userService');

async function settingsRoutes(app) {
  // Get payment currency setting
  app.get('/settings/payment-currency', {
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

      // Get payment currency setting (system-wide setting)
      const result = await app.pg.query(
        `SELECT value 
         FROM public.settings 
         WHERE key = 'payment_currency' 
         AND is_system = true 
         AND owner_user_id IS NULL
         LIMIT 1`
      );

      let currency = 'INR'; // Default to INR
      if (result.rows.length > 0 && result.rows[0].value) {
        const value = result.rows[0].value;
        // Handle jsonb value - could be string or object
        if (typeof value === 'string') {
          currency = value;
        } else if (value && typeof value === 'object') {
          currency = value.currency || value.value || 'INR';
        }
      }

      return reply.send({
        currency,
      });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to fetch payment currency setting');
      return reply.code(500).send({ 
        message: 'Failed to fetch payment currency setting', 
        error: error.message 
      });
    }
  });

  // Update payment currency setting
  app.put('/settings/payment-currency', {
    preValidation: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['currency'],
        properties: {
          currency: { 
            type: 'string', 
            enum: ['INR', 'USD', 'EUR', 'GBP'] 
          },
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

      const { currency } = request.body;

      // Check if setting exists
      const existing = await app.pg.query(
        `SELECT id 
         FROM public.settings 
         WHERE key = 'payment_currency' 
         AND is_system = true 
         AND owner_user_id IS NULL
         LIMIT 1`
      );

      if (existing.rows.length > 0) {
        // Update existing setting - use to_jsonb to properly convert string to jsonb
        await app.pg.query(
          `UPDATE public.settings 
           SET value = to_jsonb($1::text), updated_at = now() 
           WHERE key = 'payment_currency' 
           AND is_system = true 
           AND owner_user_id IS NULL`,
          [currency]
        );
      } else {
        // Create new setting - use to_jsonb to properly convert string to jsonb
        await app.pg.query(
          `INSERT INTO public.settings (key, value, is_system, owner_user_id) 
           VALUES ('payment_currency', to_jsonb($1::text), true, NULL)`,
          [currency]
        );
      }

      return reply.send({
        success: true,
        message: 'Payment currency updated successfully',
        currency,
      });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to update payment currency setting');
      return reply.code(500).send({ 
        message: 'Failed to update payment currency setting', 
        error: error.message 
      });
    }
  });

  // Get payment currency (public endpoint for frontend use)
  app.get('/settings/payment-currency/public', async (request, reply) => {
    try {
      // Get payment currency setting (system-wide setting)
      const result = await app.pg.query(
        `SELECT value 
         FROM public.settings 
         WHERE key = 'payment_currency' 
         AND is_system = true 
         AND owner_user_id IS NULL
         LIMIT 1`
      );

      let currency = 'INR'; // Default to INR
      if (result.rows.length > 0 && result.rows[0].value) {
        const value = result.rows[0].value;
        // Handle jsonb value - could be string or object
        if (typeof value === 'string') {
          currency = value;
        } else if (value && typeof value === 'object') {
          currency = value.currency || value.value || 'INR';
        }
      }

      return reply.send({
        currency,
      });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to fetch payment currency setting');
      // Return default on error
      return reply.send({ currency: 'INR' });
    }
  });
}

module.exports = settingsRoutes;

