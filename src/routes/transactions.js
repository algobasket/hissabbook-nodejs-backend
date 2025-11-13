// Transactions Routes for Admin Panel
// This is used by hissabbook-react-admin (NOT hissabbook-api-system)

const { findUserByEmail, getUserRoles } = require('../services/userService');

async function transactionsRoutes(app) {
  // Get all transactions (for admin)
  app.get('/transactions', {
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

      // Check if transactions table exists
      const tableCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'transactions'
        );
      `);

      if (!tableCheck.rows[0]?.exists) {
        return reply.send({ transactions: [] });
      }

      const { type, status, limit = '100', offset = '0' } = request.query;

      let query = `
        SELECT 
          t.id,
          t.type,
          t.status,
          t.amount,
          t.currency_code,
          t.description,
          t.metadata,
          t.occurred_at,
          t.created_at,
          t.updated_at,
          t.user_id,
          t.book_id,
          t.wallet_id,
          u.email as user_email,
          ud.first_name,
          ud.last_name,
          ud.phone,
          b.name as book_name
        FROM public.transactions t
        LEFT JOIN public.users u ON t.user_id = u.id
        LEFT JOIN public.user_details ud ON u.id = ud.user_id
        LEFT JOIN public.books b ON t.book_id = b.id
      `;

      const params = [];
      const conditions = [];

      if (type && type !== 'all') {
        conditions.push(`t.type = $${params.length + 1}`);
        params.push(type);
      }

      if (status && status !== 'all') {
        conditions.push(`t.status = $${params.length + 1}`);
        params.push(status);
      }

      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      }

      query += ' ORDER BY t.occurred_at DESC, t.created_at DESC';
      query += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(parseInt(limit, 10), parseInt(offset, 10));

      const result = await app.pg.query(query, params);

      const transactions = result.rows.map((row) => {
        const fullName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || row.user_email?.split('@')[0] || 'Unknown';

        return {
          id: row.id,
          type: row.type,
          status: row.status,
          amount: parseFloat(row.amount || '0'),
          currencyCode: row.currency_code || 'INR',
          description: row.description || null,
          metadata: row.metadata || null,
          occurredAt: row.occurred_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          userId: row.user_id,
          bookId: row.book_id,
          walletId: row.wallet_id,
          userEmail: row.user_email,
          userFirstName: row.first_name,
          userLastName: row.last_name,
          userFullName: fullName,
          userPhone: row.phone,
          bookName: row.book_name,
        };
      });

      return reply.send({ transactions });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
        code: error.code,
        detail: error.detail
      }, 'Failed to fetch transactions');
      
      const errorMessage = error.detail || error.message || 'Failed to fetch transactions';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Get transactions by book_id
  app.get('/transactions/book/:bookId', {
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

      const { bookId } = request.params;
      const { type, status, limit = '100', offset = '0' } = request.query;

      // Check if transactions table exists
      const tableCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'transactions'
        );
      `);

      if (!tableCheck.rows[0]?.exists) {
        return reply.send({ transactions: [] });
      }

      let query = `
        SELECT 
          t.id,
          t.type,
          t.status,
          t.amount,
          t.currency_code,
          t.description,
          t.metadata,
          t.occurred_at,
          t.created_at,
          t.updated_at,
          t.user_id,
          t.book_id,
          t.wallet_id,
          u.email as user_email,
          ud.first_name,
          ud.last_name,
          ud.phone,
          b.name as book_name
        FROM public.transactions t
        LEFT JOIN public.users u ON t.user_id = u.id
        LEFT JOIN public.user_details ud ON u.id = ud.user_id
        LEFT JOIN public.books b ON t.book_id = b.id
        WHERE t.book_id = $1
      `;

      const params = [bookId];
      const conditions = [];

      if (type && type !== 'all') {
        conditions.push(`t.type = $${params.length + 1}`);
        params.push(type);
      }

      if (status && status !== 'all') {
        conditions.push(`t.status = $${params.length + 1}`);
        params.push(status);
      }

      if (conditions.length > 0) {
        query += ' AND ' + conditions.join(' AND ');
      }

      query += ' ORDER BY t.occurred_at DESC, t.created_at DESC';
      query += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(parseInt(limit, 10), parseInt(offset, 10));

      const result = await app.pg.query(query, params);

      const transactions = result.rows.map((row) => {
        const fullName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || row.user_email?.split('@')[0] || 'Unknown';

        return {
          id: row.id,
          type: row.type,
          status: row.status,
          amount: parseFloat(row.amount || '0'),
          currencyCode: row.currency_code || 'INR',
          description: row.description || null,
          metadata: row.metadata || null,
          occurredAt: row.occurred_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          userId: row.user_id,
          bookId: row.book_id,
          walletId: row.wallet_id,
          userEmail: row.user_email,
          userFirstName: row.first_name,
          userLastName: row.last_name,
          userFullName: fullName,
          userPhone: row.phone,
          bookName: row.book_name,
        };
      });

      return reply.send({ transactions });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
        code: error.code,
        detail: error.detail
      }, 'Failed to fetch book transactions');
      
      const errorMessage = error.detail || error.message || 'Failed to fetch book transactions';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });
}

module.exports = transactionsRoutes;

