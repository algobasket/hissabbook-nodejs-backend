// Books/Cashbooks Routes for Admin Panel
// This is used by hissabbook-react-admin (NOT hissabbook-api-system)

const { findUserByEmail, getUserRoles } = require('../services/userService');

async function booksRoutes(app) {
  // Get all books/cashbooks (for admin)
  app.get('/books', {
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

      // Check if books table exists
      const tableCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'books'
        );
      `);

      if (!tableCheck.rows[0]?.exists) {
        return reply.send({ books: [] });
      }

      const { status, search } = request.query;

      let query = `
        SELECT 
          b.id,
          b.name,
          b.description,
          b.currency_code,
          b.created_at,
          b.updated_at,
          b.owner_user_id,
          u.email as owner_email,
          ud.first_name as owner_first_name,
          ud.last_name as owner_last_name,
          ud.phone as owner_phone,
          COALESCE(
            (SELECT COUNT(*)::integer
             FROM public.transactions t 
             WHERE t.book_id = b.id),
            0
          ) as transaction_count,
          COALESCE(
            (SELECT SUM(CASE 
              WHEN t.type = 'credit' THEN t.amount 
              WHEN t.type = 'debit' THEN -t.amount 
              ELSE 0 
            END)
            FROM public.transactions t 
            WHERE t.book_id = b.id AND t.status = 'completed'),
            0
          ) as total_balance
        FROM public.books b
        INNER JOIN public.users u ON b.owner_user_id = u.id
        LEFT JOIN public.user_details ud ON u.id = ud.user_id
      `;

      const params = [];
      const conditions = [];

      if (status && status !== 'all') {
        if (status === 'active') {
          // Active: has at least one transaction
          conditions.push(`EXISTS (
            SELECT 1 FROM public.transactions t 
            WHERE t.book_id = b.id
          )`);
        } else if (status === 'inactive') {
          // Inactive: has no transactions
          conditions.push(`NOT EXISTS (
            SELECT 1 FROM public.transactions t 
            WHERE t.book_id = b.id
          )`);
        }
      }

      if (search && search.trim() !== '') {
        conditions.push(`(
          b.name ILIKE $${params.length + 1} OR 
          b.description ILIKE $${params.length + 1} OR
          u.email ILIKE $${params.length + 1} OR
          ud.first_name ILIKE $${params.length + 1} OR
          ud.last_name ILIKE $${params.length + 1}
        )`);
        params.push(`%${search.trim()}%`);
      }

      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      }

      query += ' ORDER BY b.updated_at DESC, b.created_at DESC';

      const result = await app.pg.query(query, params.length > 0 ? params : undefined);

      const books = result.rows.map((row) => {
        const ownerFullName = [row.owner_first_name, row.owner_last_name]
          .filter(Boolean)
          .join(' ')
          .trim() || row.owner_email?.split('@')[0] || 'Unknown';

        return {
          id: row.id,
          name: row.name,
          description: row.description || null,
          currencyCode: row.currency_code || 'INR',
          ownerId: row.owner_user_id,
          ownerEmail: row.owner_email,
          ownerName: ownerFullName,
          ownerFirstName: row.owner_first_name || null,
          ownerLastName: row.owner_last_name || null,
          ownerPhone: row.owner_phone || null,
          transactionCount: parseInt(row.transaction_count || '0', 10),
          totalBalance: parseFloat(row.total_balance || '0'),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      });

      return reply.send({ books });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
        code: error.code,
        detail: error.detail
      }, 'Failed to fetch books');
      
      const errorMessage = error.detail || error.message || 'Failed to fetch books';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Create new book/cashbook (admin only)
  app.post('/books', {
    preValidation: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'ownerUserId'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          currencyCode: { type: 'string', default: 'INR' },
          ownerUserId: { type: 'string', format: 'uuid' },
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

      const { name, description, currencyCode, ownerUserId } = request.body;

      // Verify owner user exists
      const ownerCheck = await app.pg.query(
        'SELECT id, email FROM public.users WHERE id = $1',
        [ownerUserId]
      );

      if (ownerCheck.rows.length === 0) {
        return reply.code(404).send({ message: 'Owner user not found' });
      }

      // Create book
      const result = await app.pg.query(
        `INSERT INTO public.books (name, description, currency_code, owner_user_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, description, currency_code, owner_user_id, created_at, updated_at`,
        [name, description || null, currencyCode || 'INR', ownerUserId]
      );

      const newBook = result.rows[0];

      // Get owner details
      const ownerDetails = await app.pg.query(
        `SELECT u.email, ud.first_name, ud.last_name, ud.phone
         FROM public.users u
         LEFT JOIN public.user_details ud ON u.id = ud.user_id
         WHERE u.id = $1`,
        [ownerUserId]
      );

      const owner = ownerDetails.rows[0];
      const ownerFullName = [owner?.first_name, owner?.last_name]
        .filter(Boolean)
        .join(' ')
        .trim() || owner?.email?.split('@')[0] || 'Unknown';

      return reply.code(201).send({
        success: true,
        book: {
          id: newBook.id,
          name: newBook.name,
          description: newBook.description || null,
          currencyCode: newBook.currency_code || 'INR',
          ownerId: newBook.owner_user_id,
          ownerEmail: owner?.email,
          ownerName: ownerFullName,
          ownerFirstName: owner?.first_name || null,
          ownerLastName: owner?.last_name || null,
          ownerPhone: owner?.phone || null,
          transactionCount: 0,
          totalBalance: 0,
          createdAt: newBook.created_at,
          updatedAt: newBook.updated_at,
        },
      });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
        code: error.code,
        detail: error.detail
      }, 'Failed to create book');
      
      const errorMessage = error.detail || error.message || 'Failed to create book';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Get single book by ID
  app.get('/books/:id', {
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

      // Check if books table exists
      const tableCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'books'
        );
      `);

      if (!tableCheck.rows[0]?.exists) {
        return reply.code(404).send({ message: 'Book not found' });
      }

      const result = await app.pg.query(
        `SELECT 
          b.id,
          b.name,
          b.description,
          b.currency_code,
          b.created_at,
          b.updated_at,
          b.owner_user_id,
          u.email as owner_email,
          ud.first_name as owner_first_name,
          ud.last_name as owner_last_name,
          ud.phone as owner_phone,
          COALESCE(
            (SELECT COUNT(*)::integer
             FROM public.transactions t 
             WHERE t.book_id = b.id),
            0
          ) as transaction_count,
          COALESCE(
            (SELECT SUM(CASE 
              WHEN t.type = 'credit' THEN t.amount 
              WHEN t.type = 'debit' THEN -t.amount 
              ELSE 0 
            END)
            FROM public.transactions t 
            WHERE t.book_id = b.id AND t.status = 'completed'),
            0
          ) as total_balance
        FROM public.books b
        INNER JOIN public.users u ON b.owner_user_id = u.id
        LEFT JOIN public.user_details ud ON u.id = ud.user_id
        WHERE b.id = $1`,
        [id]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ message: 'Book not found' });
      }

      const row = result.rows[0];
      const ownerFullName = [row.owner_first_name, row.owner_last_name]
        .filter(Boolean)
        .join(' ')
        .trim() || row.owner_email?.split('@')[0] || 'Unknown';

      const book = {
        id: row.id,
        name: row.name,
        description: row.description || null,
        currencyCode: row.currency_code || 'INR',
        ownerId: row.owner_user_id,
        ownerEmail: row.owner_email,
        ownerName: ownerFullName,
        ownerFirstName: row.owner_first_name || null,
        ownerLastName: row.owner_last_name || null,
        ownerPhone: row.owner_phone || null,
        transactionCount: parseInt(row.transaction_count || '0', 10),
        totalBalance: parseFloat(row.total_balance || '0'),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };

      return reply.send({ book });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
        code: error.code,
        detail: error.detail
      }, 'Failed to fetch book');
      
      const errorMessage = error.detail || error.message || 'Failed to fetch book';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Get users associated with a book
  app.get('/books/:id/users', {
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

      const { id: bookId } = request.params;

      // Check if book exists
      const bookCheck = await app.pg.query('SELECT id FROM public.books WHERE id = $1', [bookId]);
      if (bookCheck.rows.length === 0) {
        return reply.code(404).send({ message: 'Book not found' });
      }

      // Check if book_users table exists
      const tableCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'book_users'
        );
      `);

      if (!tableCheck.rows[0]?.exists) {
        return reply.send({ users: [] });
      }

      const result = await app.pg.query(
        `SELECT 
          u.id,
          u.email,
          u.status,
          ud.first_name,
          ud.last_name,
          ud.phone,
          bu.added_at
        FROM public.book_users bu
        INNER JOIN public.users u ON bu.user_id = u.id
        LEFT JOIN public.user_details ud ON u.id = ud.user_id
        WHERE bu.book_id = $1
        ORDER BY bu.added_at DESC`,
        [bookId]
      );

      const users = result.rows.map((row) => {
        const fullName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || row.email?.split('@')[0] || 'Unknown';
        return {
          id: row.id,
          email: row.email,
          name: fullName,
          firstName: row.first_name || null,
          lastName: row.last_name || null,
          phone: row.phone || null,
          status: row.status,
          addedAt: row.added_at,
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
      }, 'Failed to fetch book users');
      
      const errorMessage = error.detail || error.message || 'Failed to fetch book users';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Add user to book
  app.post('/books/:id/users', {
    preValidation: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['userId'],
        properties: {
          userId: { type: 'string', format: 'uuid' },
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

      const { id: bookId } = request.params;
      const { userId } = request.body;

      // Check if book exists
      const bookCheck = await app.pg.query('SELECT id FROM public.books WHERE id = $1', [bookId]);
      if (bookCheck.rows.length === 0) {
        return reply.code(404).send({ message: 'Book not found' });
      }

      // Check if user exists
      const userCheck = await app.pg.query('SELECT id, email FROM public.users WHERE id = $1', [userId]);
      if (userCheck.rows.length === 0) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Check if book_users table exists
      const tableCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'book_users'
        );
      `);

      if (!tableCheck.rows[0]?.exists) {
        return reply.code(500).send({ message: 'Book users table does not exist. Please run migration.' });
      }

      // Add user to book (using ON CONFLICT to handle duplicates gracefully)
      const result = await app.pg.query(
        `INSERT INTO public.book_users (book_id, user_id, added_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (book_id, user_id) DO NOTHING
         RETURNING id, book_id, user_id, added_at`,
        [bookId, userId, user.id]
      );

      if (result.rows.length === 0) {
        return reply.code(409).send({ message: 'User is already associated with this book' });
      }

      // Get the added user details
      const addedUser = userCheck.rows[0];
      const userDetails = await app.pg.query(
        `SELECT first_name, last_name, phone
         FROM public.user_details
         WHERE user_id = $1`,
        [userId]
      );

      const details = userDetails.rows[0];
      const fullName = [details?.first_name, details?.last_name].filter(Boolean).join(' ').trim() || addedUser.email?.split('@')[0] || 'Unknown';

      return reply.code(201).send({
        success: true,
        user: {
          id: addedUser.id,
          email: addedUser.email,
          name: fullName,
          firstName: details?.first_name || null,
          lastName: details?.last_name || null,
          phone: details?.phone || null,
          addedAt: result.rows[0].added_at,
        },
      });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
        code: error.code,
        detail: error.detail
      }, 'Failed to add user to book');
      
      const errorMessage = error.detail || error.message || 'Failed to add user to book';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Remove user from book
  app.delete('/books/:id/users/:userId', {
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

      const { id: bookId, userId } = request.params;

      // Check if book_users table exists
      const tableCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'book_users'
        );
      `);

      if (!tableCheck.rows[0]?.exists) {
        return reply.code(404).send({ message: 'Book users table does not exist' });
      }

      const result = await app.pg.query(
        'DELETE FROM public.book_users WHERE book_id = $1 AND user_id = $2',
        [bookId, userId]
      );

      if (result.rowCount === 0) {
        return reply.code(404).send({ message: 'User is not associated with this book' });
      }

      return reply.send({
        success: true,
        message: 'User removed from book successfully',
      });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
        code: error.code,
        detail: error.detail
      }, 'Failed to remove user from book');
      
      const errorMessage = error.detail || error.message || 'Failed to remove user from book';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });
}

module.exports = booksRoutes;

