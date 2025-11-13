// Wallets Routes for Admin Panel
// This is used by hissabbook-react-admin (NOT hissabbook-api-system)

const { findUserByEmail, getUserRoles } = require('../services/userService');

async function walletsRoutes(app) {
  // Get all user wallets (for admin)
  app.get('/wallets', {
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

      // Check if user_wallets table exists
      const tableCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'user_wallets'
        );
      `);

      if (!tableCheck.rows[0]?.exists) {
        return reply.send({ wallets: [] });
      }

      // Ensure all users have wallets (create missing wallets)
      await app.pg.query(`
        INSERT INTO public.user_wallets (user_id, balance, currency_code)
        SELECT u.id, 0, 'INR'
        FROM public.users u
        WHERE NOT EXISTS (
          SELECT 1 FROM public.user_wallets uw WHERE uw.user_id = u.id
        )
        ON CONFLICT (user_id) DO NOTHING
      `);

      // Check if id column exists in user_wallets table
      const idColumnCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
          AND table_name = 'user_wallets'
          AND column_name = 'id'
        );
      `);
      
      const hasIdColumn = idColumnCheck.rows[0]?.exists;
      const walletIdField = hasIdColumn ? 'uw.id' : 'uw.user_id';

      const query = `
        SELECT 
          ${walletIdField} as wallet_id,
          uw.user_id,
          uw.balance,
          uw.currency_code,
          uw.created_at as wallet_created_at,
          uw.updated_at as wallet_updated_at,
          u.email,
          u.status as user_status,
          ud.first_name,
          ud.last_name,
          ud.phone,
          ud.upi_id
        FROM public.user_wallets uw
        INNER JOIN public.users u ON uw.user_id = u.id
        LEFT JOIN public.user_details ud ON u.id = ud.user_id
        ORDER BY uw.updated_at DESC, uw.created_at DESC
      `;

      const result = await app.pg.query(query);

      const wallets = result.rows.map((row) => {
        const fullName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || row.email?.split('@')[0] || 'Unknown';

        return {
          id: row.wallet_id,
          userId: row.user_id,
          email: row.email,
          firstName: row.first_name || null,
          lastName: row.last_name || null,
          fullName: fullName,
          phone: row.phone || null,
          upiId: row.upi_id || null,
          balance: parseFloat(row.balance || '0'),
          currencyCode: row.currency_code || 'INR',
          userStatus: row.user_status,
          createdAt: row.wallet_created_at,
          updatedAt: row.wallet_updated_at,
        };
      });

      return reply.send({ wallets });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
        code: error.code,
        detail: error.detail
      }, 'Failed to fetch wallets');
      
      const errorMessage = error.detail || error.message || 'Failed to fetch wallets';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Get all businesses with Master UPI Wallet ID (for admin)
  app.get('/businesses-wallets', {
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
          b.master_wallet_upi,
          b.status,
          b.created_at,
          b.updated_at,
          u.email as owner_email,
          ud.first_name as owner_first_name,
          ud.last_name as owner_last_name
        FROM public.businesses b
        INNER JOIN public.users u ON b.owner_user_id = u.id
        LEFT JOIN public.user_details ud ON u.id = ud.user_id
        ORDER BY b.created_at DESC
      `;

      const result = await app.pg.query(query);

      const businesses = result.rows.map((row) => {
        const ownerFullName = [row.owner_first_name, row.owner_last_name]
          .filter(Boolean)
          .join(' ')
          .trim() || row.owner_email?.split('@')[0] || 'Unknown';

        return {
          id: row.id,
          name: row.name,
          description: row.description || null,
          masterWalletUpi: row.master_wallet_upi || null,
          ownerEmail: row.owner_email,
          ownerName: ownerFullName,
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
      }, 'Failed to fetch businesses with wallets');
      
      const errorMessage = error.detail || error.message || 'Failed to fetch businesses with wallets';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });
}

module.exports = walletsRoutes;

