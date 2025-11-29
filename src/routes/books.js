// Books/Cashbooks Routes for Admin Panel
// This is used by hissabbook-react-admin (NOT hissabbook-api-system)

const { findUserByEmail, getUserRoles, hasPermission } = require('../services/userService');
const { saveFileToDisk, deleteFileFromDisk } = require('../utils/fileUpload');
const fs = require('fs/promises');
const path = require('path');

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

      // Check if user has permission to view cashbooks
      const canView = await hasPermission(app.pg, user.id, 'cashbooks.view');
      if (!canView) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to view cashbooks.' });
      }

      // Check if user is admin
      const roles = await getUserRoles(app.pg, user.id);
      const isAdmin = roles.includes('admin');

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

      const { status, search, business_id } = request.query;

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
            (SELECT COUNT(*)::integer
             FROM public.book_users bu 
             WHERE bu.book_id = b.id),
            1
          ) as member_count,
          COALESCE(
            (SELECT SUM(CASE 
              WHEN e.entry_type = 'cash_in' THEN e.amount 
              WHEN e.entry_type = 'cash_out' THEN -e.amount 
              ELSE 0 
            END)
            FROM public.entries e 
            WHERE e.book_id = b.id),
            0
          ) as total_balance,
          COALESCE(biz.master_wallet_balance, 0) as master_wallet_balance
        FROM public.books b
        INNER JOIN public.users u ON b.owner_user_id = u.id
        LEFT JOIN public.user_details ud ON u.id = ud.user_id
        LEFT JOIN public.businesses biz ON b.business_id = biz.id
      `;

      const params = [];
      const conditions = [];

      // For non-admin users, only show books they own or are members of
      if (!isAdmin) {
        const userIdParamIndex = params.length + 1;
        conditions.push(`(
          b.owner_user_id = $${userIdParamIndex} OR
          EXISTS (
            SELECT 1 FROM public.book_users bu 
            WHERE bu.book_id = b.id AND bu.user_id = $${userIdParamIndex}
          )
        )`);
        params.push(user.id);
        request.log.info({ userId: user.id, email: user.email }, 'Filtering books for non-admin user');
      } else {
        request.log.info({ userId: user.id, email: user.email }, 'Admin user - showing all books');
      }

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

      // Filter by business_id if provided (but skip for admins - they see all books)
      if (business_id && business_id.trim() !== '' && !isAdmin) {
        conditions.push(`b.business_id = $${params.length + 1}`);
        params.push(business_id.trim());
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
          memberCount: parseInt(row.member_count || '1', 10),
          totalBalance: parseFloat(row.total_balance || '0'),
          masterWalletBalance: parseFloat(row.master_wallet_balance || '0'),
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
          businessId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Check if user has permission to create cashbooks
      const canCreate = await hasPermission(app.pg, user.id, 'cashbooks.create');
      if (!canCreate) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to create cashbooks.' });
      }

      const { name, description, currencyCode, ownerUserId, businessId } = request.body;

      // Verify owner user exists
      const ownerCheck = await app.pg.query(
        'SELECT id, email FROM public.users WHERE id = $1',
        [ownerUserId]
      );

      if (ownerCheck.rows.length === 0) {
        return reply.code(404).send({ message: 'Owner user not found' });
      }

      // Verify business exists if businessId is provided
      if (businessId) {
        const businessCheck = await app.pg.query(
          'SELECT id FROM public.businesses WHERE id = $1',
          [businessId]
        );

        if (businessCheck.rows.length === 0) {
          return reply.code(404).send({ message: 'Business not found' });
        }
      }

      // Create book
      const result = await app.pg.query(
        `INSERT INTO public.books (name, description, currency_code, owner_user_id, business_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, description, currency_code, owner_user_id, business_id, created_at, updated_at`,
        [name, description || null, currencyCode || 'INR', ownerUserId, businessId || null]
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
          masterWalletBalance: 0,
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

  // Get role permissions dynamically from database (for displaying in UI)
  // MUST be registered before /books/:id to avoid route conflicts
  app.get('/books/role-permissions', {
    preValidation: [app.authenticate],
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Check if user has permission to view cashbooks
      const canView = await hasPermission(app.pg, user.id, 'cashbooks.view');
      if (!canView) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to view cashbooks.' });
      }

      // Get all roles from database dynamically
      // Order: Managers, Admin, Staff, Agents, Auditor
      const rolesResult = await app.pg.query(
        `SELECT id, name, description 
         FROM public.roles 
         ORDER BY CASE 
           WHEN name = 'managers' THEN 1
           WHEN name = 'admin' THEN 2
           WHEN name = 'staff' THEN 3
           WHEN name = 'agents' THEN 4
           WHEN name = 'auditor' THEN 5
           ELSE 99
         END`
      );

      // Format permission descriptions to be more user-friendly
      const formatPermissionDescription = (permission) => {
        const descriptionMap = {
          'cashbooks.view': 'View entries and download reports',
          'cashbooks.create': 'Add Cash In or Cash Out entries',
          'cashbooks.update': 'Edit and delete entries',
          'cashbooks.delete': 'Duplicate and Delete Book',
        };
        return descriptionMap[permission.code] || permission.description || permission.name;
      };

      // Get permissions for each role dynamically from database
      const rolePermissions = [];

      for (const role of rolesResult.rows) {
        // Fetch permissions for this role from database
        const permissionsResult = await app.pg.query(
          `SELECT 
            p.id,
            p.name,
            p.code,
            p.description,
            p.category
          FROM public.permissions p
          INNER JOIN public.role_permissions rp ON p.id = rp.permission_id
          WHERE rp.role_id = $1 AND p.code LIKE 'cashbooks.%'
          ORDER BY p.category, p.name ASC`,
          [role.id]
        );

        // Format and assign permissions
        rolePermissions.push({
          id: role.id,
          name: role.name,
          description: role.description,
          permissions: permissionsResult.rows.map(row => ({
            id: row.id,
            name: row.name,
            code: row.code,
            description: formatPermissionDescription(row),
            category: row.category,
          })),
        });
      }

      return reply.send({ roles: rolePermissions });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
        code: error.code,
        detail: error.detail
      }, 'Failed to fetch role permissions');
      
      const errorMessage = error.detail || error.message || 'Failed to fetch role permissions';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Get parties for a book - must be before /books/:id to avoid route conflicts
  app.get('/books/:id/parties', {
    preValidation: [app.authenticate],
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Check if user has permission to view cashbooks
      const canView = await hasPermission(app.pg, user.id, 'cashbooks.view');
      if (!canView) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to view cashbooks.' });
      }

      const { id: bookId } = request.params;

      // Verify book exists and user has access
      const bookResult = await app.pg.query(
        `SELECT b.id, b.owner_user_id, b.business_id
         FROM public.books b
         WHERE b.id = $1`,
        [bookId]
      );

      if (bookResult.rows.length === 0) {
        return reply.code(404).send({ message: 'Book not found' });
      }

      const book = bookResult.rows[0];

      // Check if user is admin (can see all books) or has access to this book
      const roles = await getUserRoles(app.pg, user.id);
      const isAdmin = roles.includes('admin');

      if (!isAdmin && book.owner_user_id !== user.id) {
        // Check if user is a member of this book
        const memberCheck = await app.pg.query(
          'SELECT 1 FROM public.book_users WHERE book_id = $1 AND user_id = $2',
          [bookId, user.id]
        );

        if (memberCheck.rows.length === 0) {
          return reply.code(403).send({ message: 'Access denied. You do not have access to this book.' });
        }
      }

      // Fetch parties for this book
      const partiesResult = await app.pg.query(
        `SELECT id, name, mobile, party_type, created_at, updated_at
         FROM public.parties
         WHERE book_id = $1
         ORDER BY name ASC`,
        [bookId]
      );

      return reply.send({ parties: partiesResult.rows });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to fetch parties');
      return reply.code(500).send({
        message: 'Failed to fetch parties',
        error: error.message
      });
    }
  });

  // Create a new party for a book - must be before /books/:id to avoid route conflicts
  app.post('/books/:id/parties', {
    preValidation: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1 },
          mobile: { type: 'string' },
          partyType: { type: 'string', enum: ['Customer', 'Supplier'] },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Check if user has permission to manage cashbooks (update, cashin, or cashout)
      const canUpdate = await hasPermission(app.pg, user.id, 'cashbooks.update');
      const canCashIn = await hasPermission(app.pg, user.id, 'cashbooks.cashin');
      const canCashOut = await hasPermission(app.pg, user.id, 'cashbooks.cashout');
      const canCreate = await hasPermission(app.pg, user.id, 'cashbooks.create');
      
      if (!canUpdate && !canCashIn && !canCashOut && !canCreate) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to manage cashbooks.' });
      }

      const { id: bookId } = request.params;
      const { name, mobile, partyType } = request.body;

      // Verify book exists and user has access
      const bookResult = await app.pg.query(
        `SELECT b.id, b.owner_user_id
         FROM public.books b
         WHERE b.id = $1`,
        [bookId]
      );

      if (bookResult.rows.length === 0) {
        return reply.code(404).send({ message: 'Book not found' });
      }

      const book = bookResult.rows[0];

      // Check if user is admin or owner
      const roles = await getUserRoles(app.pg, user.id);
      const isAdmin = roles.includes('admin');
      const isOwner = book.owner_user_id === user.id;

      // If not admin and not owner, check if user is a member of the book and has cashin/cashout permissions
      if (!isAdmin && !isOwner) {
        // Check if user is a member of this book (via book_users table)
        const bookMemberCheck = await app.pg.query(
          'SELECT id FROM public.book_users WHERE book_id = $1 AND user_id = $2',
          [bookId, user.id]
        );

        if (bookMemberCheck.rows.length === 0) {
          return reply.code(403).send({ message: 'Access denied. You must be a member of this book to add parties.' });
        }

        // User is a member, check if they have cashin or cashout permissions
        if (!canCashIn && !canCashOut) {
          return reply.code(403).send({ message: 'Access denied. You need Cash In or Cash Out permissions to add parties.' });
        }
      }

      // Insert new party
      const result = await app.pg.query(
        `INSERT INTO public.parties (book_id, name, mobile, party_type)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, mobile, party_type, created_at, updated_at`,
        [bookId, name.trim(), mobile?.trim() || null, partyType || 'Customer']
      );

      return reply.code(201).send({ party: result.rows[0] });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to create party');
      return reply.code(500).send({
        message: 'Failed to create party',
        error: error.message
      });
    }
  });

  // Get categories for a book - must be before /books/:id to avoid route conflicts
  app.get('/books/:id/categories', {
    preValidation: [app.authenticate],
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Check if user has permission to view cashbooks
      const canView = await hasPermission(app.pg, user.id, 'cashbooks.view');
      if (!canView) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to view cashbooks.' });
      }

      const { id: bookId } = request.params;

      // Verify book exists and user has access
      const bookResult = await app.pg.query(
        `SELECT b.id, b.owner_user_id, b.business_id
         FROM public.books b
         WHERE b.id = $1`,
        [bookId]
      );

      if (bookResult.rows.length === 0) {
        return reply.code(404).send({ message: 'Book not found' });
      }

      const book = bookResult.rows[0];

      // Check if user is admin (can see all books) or has access to this book
      const roles = await getUserRoles(app.pg, user.id);
      const isAdmin = roles.includes('admin');

      if (!isAdmin && book.owner_user_id !== user.id) {
        // Check if user is a member of this book
        const memberCheck = await app.pg.query(
          'SELECT 1 FROM public.book_users WHERE book_id = $1 AND user_id = $2',
          [bookId, user.id]
        );

        if (memberCheck.rows.length === 0) {
          return reply.code(403).send({ message: 'Access denied. You do not have access to this book.' });
        }
      }

      // Fetch book-specific categories
      const bookCategoriesResult = await app.pg.query(
        `SELECT id, name, is_suggestion, created_at, updated_at
         FROM public.categories
         WHERE book_id = $1 AND is_suggestion = false
         ORDER BY name ASC`,
        [bookId]
      );

      // Fetch global suggestion categories
      const suggestionsResult = await app.pg.query(
        `SELECT id, name, is_suggestion, created_at, updated_at
         FROM public.categories
         WHERE is_suggestion = true
         ORDER BY name ASC`
      );

      return reply.send({ 
        bookCategories: bookCategoriesResult.rows,
        suggestions: suggestionsResult.rows
      });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to fetch categories');
      return reply.code(500).send({
        message: 'Failed to fetch categories',
        error: error.message
      });
    }
  });

  // Create a new category for a book - must be before /books/:id to avoid route conflicts
  app.post('/books/:id/categories', {
    preValidation: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Check if user has permission to manage cashbooks (update, cashin, or cashout)
      const canUpdate = await hasPermission(app.pg, user.id, 'cashbooks.update');
      const canCashIn = await hasPermission(app.pg, user.id, 'cashbooks.cashin');
      const canCashOut = await hasPermission(app.pg, user.id, 'cashbooks.cashout');
      const canCreate = await hasPermission(app.pg, user.id, 'cashbooks.create');
      
      if (!canUpdate && !canCashIn && !canCashOut && !canCreate) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to manage cashbooks.' });
      }

      const { id: bookId } = request.params;
      const { name } = request.body;

      // Verify book exists and user has access
      const bookResult = await app.pg.query(
        `SELECT b.id, b.owner_user_id
         FROM public.books b
         WHERE b.id = $1`,
        [bookId]
      );

      if (bookResult.rows.length === 0) {
        return reply.code(404).send({ message: 'Book not found' });
      }

      const book = bookResult.rows[0];

      // Check if user is admin or owner
      const roles = await getUserRoles(app.pg, user.id);
      const isAdmin = roles.includes('admin');

      if (!isAdmin && book.owner_user_id !== user.id) {
        return reply.code(403).send({ message: 'Access denied. Only the book owner can add categories.' });
      }

      // Insert new category (book-specific, not a suggestion)
      const result = await app.pg.query(
        `INSERT INTO public.categories (book_id, name, is_suggestion)
         VALUES ($1, $2, false)
         ON CONFLICT (book_id, name) DO UPDATE SET updated_at = now()
         RETURNING id, name, is_suggestion, created_at, updated_at`,
        [bookId, name.trim()]
      );

      return reply.code(201).send({ category: result.rows[0] });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to create category');
      return reply.code(500).send({
        message: 'Failed to create category',
        error: error.message
      });
    }
  });

  // Upload file attachment for a book entry - must be before /books/:id to avoid route conflicts
  app.post('/books/:id/attachments', {
    preValidation: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['file'],
        properties: {
          file: { type: 'string' }, // Base64 encoded file
        },
      },
    },
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Check if user has permission to manage cashbooks (update, cashin, or cashout)
      const canUpdate = await hasPermission(app.pg, user.id, 'cashbooks.update');
      const canCashIn = await hasPermission(app.pg, user.id, 'cashbooks.cashin');
      const canCashOut = await hasPermission(app.pg, user.id, 'cashbooks.cashout');
      const canCreate = await hasPermission(app.pg, user.id, 'cashbooks.create');
      
      if (!canUpdate && !canCashIn && !canCashOut && !canCreate) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to manage cashbooks.' });
      }

      const { id: bookId } = request.params;
      const { file } = request.body;

      // Verify book exists and user has access
      const bookResult = await app.pg.query(
        `SELECT b.id, b.owner_user_id
         FROM public.books b
         WHERE b.id = $1`,
        [bookId]
      );

      if (bookResult.rows.length === 0) {
        return reply.code(404).send({ message: 'Book not found' });
      }

      const book = bookResult.rows[0];

      // Check if user is admin or owner
      const roles = await getUserRoles(app.pg, user.id);
      const isAdmin = roles.includes('admin');
      const isOwner = book.owner_user_id === user.id;

      // Also check if user has cashin/cashout permissions and is a member of the book
      if (!isAdmin && !isOwner) {
        const canCashIn = await hasPermission(app.pg, user.id, 'cashbooks.cashin');
        const canCashOut = await hasPermission(app.pg, user.id, 'cashbooks.cashout');
        const canCreate = await hasPermission(app.pg, user.id, 'cashbooks.create');
        const canUpdate = await hasPermission(app.pg, user.id, 'cashbooks.update');
        
        const hasEntryPermission = canCashIn || canCashOut || canCreate || canUpdate;
        
        if (hasEntryPermission) {
          // Check if user is a member of this book
          const memberCheck = await app.pg.query(
            'SELECT 1 FROM public.book_users WHERE book_id = $1 AND user_id = $2',
            [bookId, user.id]
          );
          
          if (memberCheck.rows.length === 0) {
            return reply.code(403).send({ message: 'Access denied. You must be a member of this book to upload attachments.' });
          }
        } else {
          return reply.code(403).send({ message: 'Access denied. Only the book owner can upload attachments.' });
        }
      }

      // Save file to disk
      const fileInfo = await saveFileToDisk(file, 'bill');

      // Store file reference in database (entry_id will be set when entry is created)
      const result = await app.pg.query(
        `INSERT INTO public.entry_attachments (book_id, file_name, file_path, file_type, file_size, mime_type)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, file_name, file_type, file_size, mime_type, created_at`,
        [bookId, fileInfo.fileName, fileInfo.filePath, fileInfo.fileType, fileInfo.fileSize, fileInfo.mimeType]
      );

      return reply.code(201).send({ attachment: result.rows[0] });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to upload attachment');
      return reply.code(500).send({
        message: 'Failed to upload attachment',
        error: error.message
      });
    }
  });

  // Get attachments for an entry
  app.get('/books/:id/entries/:entryId/attachments', {
    preValidation: [app.authenticate],
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      const { id: bookId, entryId } = request.params;

      // Verify entry exists and belongs to the book
      const entryResult = await app.pg.query(
        `SELECT id FROM public.entries WHERE id = $1 AND book_id = $2`,
        [entryId, bookId]
      );

      if (entryResult.rows.length === 0) {
        return reply.code(404).send({ message: 'Entry not found' });
      }

      // Fetch attachments for this entry
      // First try to get attachments linked to this entry
      let attachmentsResult = await app.pg.query(
        `SELECT 
          id,
          file_name,
          file_path,
          file_type,
          file_size,
          mime_type,
          created_at
         FROM public.entry_attachments
         WHERE entry_id = $1 AND book_id = $2
         ORDER BY created_at ASC`,
        [entryId, bookId]
      );

      // If no attachments found and entry was created recently, 
      // try to find orphaned attachments (entry_id is null) for this book
      // that were created around the same time as the entry
      if (attachmentsResult.rows.length === 0) {
        const entryInfo = await app.pg.query(
          `SELECT created_at FROM public.entries WHERE id = $1`,
          [entryId]
        );
        
        if (entryInfo.rows.length > 0) {
          const entryCreatedAt = entryInfo.rows[0].created_at;
          // Look for attachments created within 5 minutes of entry creation
          const timeWindow = new Date(entryCreatedAt);
          timeWindow.setMinutes(timeWindow.getMinutes() - 5);
          
          attachmentsResult = await app.pg.query(
            `SELECT 
              id,
              file_name,
              file_path,
              file_type,
              file_size,
              mime_type,
              created_at
             FROM public.entry_attachments
             WHERE entry_id IS NULL 
               AND book_id = $1
               AND created_at >= $2
               AND created_at <= $3
             ORDER BY created_at ASC
             LIMIT 10`,
            [bookId, timeWindow.toISOString(), entryCreatedAt]
          );
          
          // If we found orphaned attachments, link them to this entry
          if (attachmentsResult.rows.length > 0) {
            const attachmentIds = attachmentsResult.rows.map(row => row.id);
            await app.pg.query(
              `UPDATE public.entry_attachments
               SET entry_id = $1, updated_at = now()
               WHERE id = ANY($2::uuid[]) AND book_id = $3`,
              [entryId, attachmentIds, bookId]
            );
            request.log.info({ entryId, attachmentIds }, 'Auto-linked orphaned attachments to entry');
          }
        }
      }

      const attachments = attachmentsResult.rows.map((row) => {
        // Extract just the filename from file_path if it's a full path
        const fileName = row.file_path.includes('/') 
          ? row.file_path.split('/').pop() 
          : row.file_name;
        
        return {
          id: row.id,
          file_name: row.file_name,
          file_path: row.file_path,
          path: row.file_path, // Alias for compatibility
          url: `/uploads/${fileName}`, // Construct URL for serving files
          file_type: row.file_type,
          mime_type: row.mime_type,
          type: row.mime_type, // Alias for compatibility
          file_size: row.file_size,
          created_at: row.created_at,
        };
      });

      return reply.send({ attachments });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to fetch entry attachments');
      return reply.code(500).send({
        message: 'Failed to fetch entry attachments',
        error: error.message
      });
    }
  });

  // Delete file attachment - must be before /books/:id to avoid route conflicts
  app.delete('/books/:id/attachments/:attachmentId', {
    preValidation: [app.authenticate],
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Check if user has permission to manage cashbooks (update, cashin, or cashout)
      const canUpdate = await hasPermission(app.pg, user.id, 'cashbooks.update');
      const canCashIn = await hasPermission(app.pg, user.id, 'cashbooks.cashin');
      const canCashOut = await hasPermission(app.pg, user.id, 'cashbooks.cashout');
      const canCreate = await hasPermission(app.pg, user.id, 'cashbooks.create');
      
      if (!canUpdate && !canCashIn && !canCashOut && !canCreate) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to manage cashbooks.' });
      }

      const { id: bookId, attachmentId } = request.params;

      // Verify attachment exists and belongs to the book
      const attachmentResult = await app.pg.query(
        `SELECT id, file_name, book_id
         FROM public.entry_attachments
         WHERE id = $1 AND book_id = $2`,
        [attachmentId, bookId]
      );

      if (attachmentResult.rows.length === 0) {
        return reply.code(404).send({ message: 'Attachment not found' });
      }

      const attachment = attachmentResult.rows[0];

      // Delete file from disk
      await deleteFileFromDisk(attachment.file_name);

      // Delete from database
      await app.pg.query(
        'DELETE FROM public.entry_attachments WHERE id = $1',
        [attachmentId]
      );

      return reply.send({ success: true, message: 'Attachment deleted successfully' });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to delete attachment');
      return reply.code(500).send({
        message: 'Failed to delete attachment',
        error: error.message
      });
    }
  });

  // Duplicate book - must be before /books/:id to avoid route conflicts
  app.post('/books/:id/duplicate', {
    preValidation: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['newName'],
        properties: {
          newName: { type: 'string', minLength: 1 },
          duplicateMembers: { type: 'boolean', default: false },
          duplicateCategories: { type: 'boolean', default: false },
          duplicatePaymentModes: { type: 'boolean', default: false },
          duplicateParties: { type: 'boolean', default: false },
          duplicateCustomFields: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Check if user has permission to create cashbooks
      const canCreate = await hasPermission(app.pg, user.id, 'cashbooks.create');
      if (!canCreate) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to create cashbooks.' });
      }

      const { id } = request.params;
      const { newName, duplicateMembers, duplicateCategories, duplicatePaymentModes, duplicateParties, duplicateCustomFields } = request.body;

      // Get original book
      const originalBook = await app.pg.query(
        'SELECT * FROM public.books WHERE id = $1',
        [id]
      );

      if (originalBook.rows.length === 0) {
        return reply.code(404).send({ message: 'Book not found' });
      }

      const book = originalBook.rows[0];

      // Create new book with same settings
      const newBookResult = await app.pg.query(
        `INSERT INTO public.books (name, description, currency_code, owner_user_id, business_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, description, currency_code, owner_user_id, business_id, created_at, updated_at`,
        [newName, book.description, book.currency_code, book.owner_user_id, book.business_id]
      );

      const newBook = newBookResult.rows[0];

      // Duplicate members if requested
      if (duplicateMembers) {
        const bookUsers = await app.pg.query(
          'SELECT user_id FROM public.book_users WHERE book_id = $1',
          [id]
        );
        
        for (const row of bookUsers.rows) {
          await app.pg.query(
            'INSERT INTO public.book_users (book_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [newBook.id, row.user_id]
          );
        }
      }

      // Note: Categories, payment modes, parties, and custom fields would need their own tables
      // For now, we'll just duplicate the basic book structure and members

      return reply.send({
        success: true,
        book: {
          id: newBook.id,
          name: newBook.name,
          description: newBook.description,
          currencyCode: newBook.currency_code,
          ownerId: newBook.owner_user_id,
          createdAt: newBook.created_at,
          updatedAt: newBook.updated_at,
        },
      });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to duplicate book');
      return reply.code(500).send({ 
        message: 'Failed to duplicate book', 
        error: error.message 
      });
    }
  });

  // Create a new cash entry (cash in or cash out)
  app.post('/books/:id/entries', {
    preValidation: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['entryType', 'amount', 'entryDate', 'entryTime'],
        properties: {
          entryType: { type: 'string', enum: ['cash_in', 'cash_out'] },
          amount: { type: 'number', minimum: 0 },
          partyId: { type: 'string' },
          partyName: { type: 'string' },
          categoryId: { type: 'string' },
          categoryName: { type: 'string' },
          paymentMode: { type: 'string' },
          remarks: { type: 'string' },
          entryDate: { type: 'string' }, // ISO date string or YYYY-MM-DD
          entryTime: { type: 'string' }, // HH:MM:SS or HH:MM format
          attachmentIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      const { id: bookId } = request.params;
      const {
        entryType,
        amount,
        partyId,
        partyName,
        categoryId,
        categoryName,
        paymentMode,
        remarks,
        entryDate,
        entryTime,
        attachmentIds = [],
      } = request.body;

      // Check if user has permission to create this specific type of entry
      // Check for specific permission (cashin/cashout) OR general create permission
      const specificPermission = entryType === 'cash_in' ? 'cashbooks.cashin' : 'cashbooks.cashout';
      const hasSpecificPermission = await hasPermission(app.pg, user.id, specificPermission);
      const hasCreatePermission = await hasPermission(app.pg, user.id, 'cashbooks.create');
      
      if (!hasSpecificPermission && !hasCreatePermission) {
        const entryTypeName = entryType === 'cash_in' ? 'cash in' : 'cash out';
        return reply.code(403).send({ 
          message: `Access denied. You do not have permission to create ${entryTypeName} entries.` 
        });
      }

      // Verify book exists and user has access
      const bookResult = await app.pg.query(
        `SELECT b.id, b.owner_user_id
         FROM public.books b
         WHERE b.id = $1`,
        [bookId]
      );

      if (bookResult.rows.length === 0) {
        return reply.code(404).send({ message: 'Book not found' });
      }

      const book = bookResult.rows[0];

      // Check if user is admin or has access to this book
      const roles = await getUserRoles(app.pg, user.id);
      const isAdmin = roles.includes('admin');

      if (!isAdmin && book.owner_user_id !== user.id) {
        // Check if user is a member of this book
        const memberCheck = await app.pg.query(
          'SELECT 1 FROM public.book_users WHERE book_id = $1 AND user_id = $2',
          [bookId, user.id]
        );

        if (memberCheck.rows.length === 0) {
          return reply.code(403).send({ message: 'Access denied. You do not have access to this book.' });
        }
      }

      // Parse date and time
      const dateObj = new Date(entryDate);
      const formattedDate = dateObj.toISOString().split('T')[0]; // YYYY-MM-DD
      
      // Parse time (handle both HH:MM:SS and HH:MM formats)
      let formattedTime = entryTime;
      if (!formattedTime.includes(':')) {
        formattedTime = '00:00:00';
      } else if (formattedTime.split(':').length === 2) {
        formattedTime = formattedTime + ':00';
      }

      // Insert entry
      const entryResult = await app.pg.query(
        `INSERT INTO public.entries (
          book_id, entry_type, amount, party_id, party_name, 
          category_id, category_name, payment_mode, remarks, 
          entry_date, entry_time, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id, book_id, entry_type, amount, party_name, category_name, 
                  payment_mode, remarks, entry_date, entry_time, created_at`,
        [
          bookId,
          entryType,
          amount,
          partyId || null,
          partyName || null,
          categoryId || null,
          categoryName || null,
          paymentMode || null,
          remarks || null,
          formattedDate,
          formattedTime,
          user.id,
        ]
      );

      const entry = entryResult.rows[0];

      // Update attachment entry_ids if provided
      if (attachmentIds && attachmentIds.length > 0) {
        try {
          // Convert attachmentIds to proper UUID array format
          const updateResult = await app.pg.query(
            `UPDATE public.entry_attachments
             SET entry_id = $1, updated_at = now()
             WHERE id = ANY($2::uuid[]) AND book_id = $3`,
            [entry.id, attachmentIds, bookId]
          );
          
          request.log.info({ 
            entryId: entry.id, 
            attachmentIds, 
            updatedCount: updateResult.rowCount 
          }, 'Linked attachments to entry');
          
          // Verify the update worked
          if (updateResult.rowCount === 0 && attachmentIds.length > 0) {
            request.log.warn({ 
              entryId: entry.id, 
              attachmentIds, 
              bookId 
            }, 'No attachments were updated - they may not exist or belong to a different book');
          }
        } catch (attachError) {
          request.log.error({ 
            err: attachError, 
            entryId: entry.id, 
            attachmentIds 
          }, 'Failed to link attachments to entry');
          // Don't fail the entry creation if attachment linking fails
        }
      }

      return reply.code(201).send({ entry });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to create entry');
      return reply.code(500).send({
        message: 'Failed to create entry',
        error: error.message
      });
    }
  });

  // Update an entry - must be before GET /books/:id/entries to avoid route conflicts
  app.put('/books/:id/entries/:entryId', {
    preValidation: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['entryType', 'amount'],
        properties: {
          entryType: { type: 'string', enum: ['cash_in', 'cash_out'] },
          amount: { type: 'number' },
          partyId: { type: 'string' },
          partyName: { type: 'string' },
          categoryId: { type: 'string' },
          categoryName: { type: 'string' },
          paymentMode: { type: 'string' },
          remarks: { type: 'string' },
          entryDate: { type: 'string' },
          entryTime: { type: 'string' },
          attachmentIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      const { id: bookId, entryId } = request.params;
      const {
        entryType,
        amount,
        partyId,
        partyName,
        categoryId,
        categoryName,
        paymentMode,
        remarks,
        entryDate,
        entryTime,
        attachmentIds = [],
      } = request.body;

      // Verify entry exists and belongs to the book
      const existingEntry = await app.pg.query(
        `SELECT id FROM public.entries WHERE id = $1 AND book_id = $2`,
        [entryId, bookId]
      );

      if (existingEntry.rows.length === 0) {
        return reply.code(404).send({ message: 'Entry not found' });
      }

      // Format date
      const formattedDate = entryDate || new Date().toISOString().split('T')[0];

      // Format time
      let formattedTime = entryTime || '00:00:00';
      if (!formattedTime.includes(':')) {
        formattedTime = '00:00:00';
      } else if (formattedTime.split(':').length === 2) {
        formattedTime = formattedTime + ':00';
      }

      // Update entry
      const entryResult = await app.pg.query(
        `UPDATE public.entries SET
          entry_type = $1,
          amount = $2,
          party_id = $3,
          party_name = $4,
          category_id = $5,
          category_name = $6,
          payment_mode = $7,
          remarks = $8,
          entry_date = $9,
          entry_time = $10,
          updated_at = now()
        WHERE id = $11 AND book_id = $12
        RETURNING id, book_id, entry_type, amount, party_name, category_name, 
                  payment_mode, remarks, entry_date, entry_time, created_at`,
        [
          entryType,
          amount,
          partyId || null,
          partyName || null,
          categoryId || null,
          categoryName || null,
          paymentMode || null,
          remarks || null,
          formattedDate,
          formattedTime,
          entryId,
          bookId,
        ]
      );

      if (entryResult.rows.length === 0) {
        return reply.code(404).send({ message: 'Entry not found or update failed' });
      }

      const entry = entryResult.rows[0];

      // First, unlink all existing attachments for this entry
      await app.pg.query(
        `UPDATE public.entry_attachments
         SET entry_id = NULL, updated_at = now()
         WHERE entry_id = $1 AND book_id = $2`,
        [entryId, bookId]
      );

      // Then, link the new attachments if provided
      if (attachmentIds && attachmentIds.length > 0) {
        try {
          const updateResult = await app.pg.query(
            `UPDATE public.entry_attachments
             SET entry_id = $1, updated_at = now()
             WHERE id = ANY($2::uuid[]) AND book_id = $3`,
            [entry.id, attachmentIds, bookId]
          );
          
          request.log.info({ 
            entryId: entry.id, 
            attachmentIds, 
            updatedCount: updateResult.rowCount 
          }, 'Linked attachments to entry');
        } catch (attachError) {
          request.log.error({ 
            err: attachError, 
            entryId: entry.id, 
            attachmentIds 
          }, 'Failed to link attachments to entry');
        }
      }

      return reply.send({ entry });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to update entry');
      return reply.code(500).send({
        message: 'Failed to update entry',
        error: error.message
      });
    }
  });

  // Delete an entry - must be before GET /books/:id/entries to avoid route conflicts
  app.delete('/books/:id/entries/:entryId', {
    preValidation: [app.authenticate],
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Check if user has permission to manage cashbooks
      const canUpdate = await hasPermission(app.pg, user.id, 'cashbooks.update');
      if (!canUpdate) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to delete entries.' });
      }

      const { id: bookId, entryId } = request.params;

      // Verify entry exists and belongs to the book
      const entryResult = await app.pg.query(
        `SELECT id FROM public.entries WHERE id = $1 AND book_id = $2`,
        [entryId, bookId]
      );

      if (entryResult.rows.length === 0) {
        return reply.code(404).send({ message: 'Entry not found' });
      }

      // Delete entry (cascade will handle related records like entry_attachments)
      await app.pg.query(
        'DELETE FROM public.entries WHERE id = $1 AND book_id = $2',
        [entryId, bookId]
      );

      return reply.send({ 
        success: true, 
        message: 'Entry deleted successfully' 
      });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to delete entry');
      return reply.code(500).send({
        message: 'Failed to delete entry',
        error: error.message
      });
    }
  });

  // Get entries for a book - must be before /books/:id to avoid route conflicts
  app.get('/books/:id/entries', {
    preValidation: [app.authenticate],
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Check if user has permission to view cashbooks
      const canView = await hasPermission(app.pg, user.id, 'cashbooks.view');
      if (!canView) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to view cashbooks.' });
      }

      const { id: bookId } = request.params;
      const { 
        entryType, 
        partyId, 
        categoryId, 
        paymentMode, 
        memberId,
        startDate,
        endDate,
        search,
        limit = 100,
        offset = 0
      } = request.query;

      // Verify book exists and user has access
      const bookResult = await app.pg.query(
        `SELECT b.id, b.owner_user_id
         FROM public.books b
         WHERE b.id = $1`,
        [bookId]
      );

      if (bookResult.rows.length === 0) {
        return reply.code(404).send({ message: 'Book not found' });
      }

      const book = bookResult.rows[0];

      // Check if user is admin or has access to this book
      const roles = await getUserRoles(app.pg, user.id);
      const isAdmin = roles.includes('admin');

      if (!isAdmin && book.owner_user_id !== user.id) {
        // Check if user is a member of this book
        const memberCheck = await app.pg.query(
          'SELECT 1 FROM public.book_users WHERE book_id = $1 AND user_id = $2',
          [bookId, user.id]
        );

        if (memberCheck.rows.length === 0) {
          return reply.code(403).send({ message: 'Access denied. You do not have access to this book.' });
        }
      }

      // Build query with filters and running balance calculation
      // Calculate balance from ALL entries (for accurate running balance)
      // Then apply filters to determine which entries to return
      let query = `
        WITH all_entries_with_balance AS (
          SELECT 
            e.id,
            e.entry_type,
            e.amount,
            e.party_id,
            e.party_name,
            e.category_id,
            e.category_name,
            e.payment_mode,
            e.remarks,
            e.entry_date,
            e.entry_time,
            e.created_at,
            e.created_by,
            u.email as created_by_email,
            ud.first_name as created_by_first_name,
            ud.last_name as created_by_last_name,
            SUM(
              CASE 
                WHEN e.entry_type = 'cash_in' THEN e.amount
                WHEN e.entry_type = 'cash_out' THEN -e.amount
                ELSE 0
              END
            ) OVER (
              PARTITION BY e.book_id 
              ORDER BY e.entry_date ASC, e.entry_time ASC, e.created_at ASC
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) as balance
          FROM public.entries e
          LEFT JOIN public.users u ON e.created_by = u.id
          LEFT JOIN public.user_details ud ON u.id = ud.user_id
          WHERE e.book_id = $1
        ),
        filtered_entries AS (
          SELECT * FROM all_entries_with_balance
          WHERE 1=1
      `;
      const queryParams = [bookId];
      let paramIndex = 2;

      if (entryType && entryType !== 'all') {
        query += ` AND entry_type = $${paramIndex}`;
        queryParams.push(entryType);
        paramIndex++;
      }

      if (partyId && partyId !== 'all') {
        query += ` AND party_id = $${paramIndex}`;
        queryParams.push(partyId);
        paramIndex++;
      }

      if (categoryId && categoryId !== 'all') {
        query += ` AND category_id = $${paramIndex}`;
        queryParams.push(categoryId);
        paramIndex++;
      }

      if (paymentMode && paymentMode !== 'all') {
        query += ` AND payment_mode = $${paramIndex}`;
        queryParams.push(paymentMode);
        paramIndex++;
      }

      if (memberId && memberId !== 'all') {
        query += ` AND created_by = $${paramIndex}`;
        queryParams.push(memberId);
        paramIndex++;
      }

      if (startDate) {
        query += ` AND entry_date >= $${paramIndex}`;
        queryParams.push(startDate);
        paramIndex++;
      }

      if (endDate) {
        query += ` AND entry_date <= $${paramIndex}`;
        queryParams.push(endDate);
        paramIndex++;
      }

      if (search) {
        query += ` AND (
          remarks ILIKE $${paramIndex} OR 
          amount::text ILIKE $${paramIndex} OR
          party_name ILIKE $${paramIndex} OR
          category_name ILIKE $${paramIndex}
        )`;
        queryParams.push(`%${search}%`);
        paramIndex++;
      }

      // Close the filtered CTE and apply final ordering and pagination
      query += `
        )
        SELECT 
          id,
          entry_type,
          amount,
          party_name,
          category_name,
          payment_mode,
          remarks,
          entry_date,
          entry_time,
          created_at,
          created_by,
          created_by_email,
          created_by_first_name,
          created_by_last_name,
          balance
        FROM filtered_entries
        ORDER BY entry_date DESC, entry_time DESC, created_at DESC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      queryParams.push(parseInt(limit), parseInt(offset));

      const result = await app.pg.query(query, queryParams);

      // Get total count for pagination
      let countQuery = `SELECT COUNT(*) as total FROM public.entries e WHERE e.book_id = $1`;
      const countParams = [bookId];
      let countParamIndex = 2;

      if (entryType && entryType !== 'all') {
        countQuery += ` AND e.entry_type = $${countParamIndex}`;
        countParams.push(entryType);
        countParamIndex++;
      }

      if (partyId && partyId !== 'all') {
        countQuery += ` AND e.party_id = $${countParamIndex}`;
        countParams.push(partyId);
        countParamIndex++;
      }

      if (categoryId && categoryId !== 'all') {
        countQuery += ` AND e.category_id = $${countParamIndex}`;
        countParams.push(categoryId);
        countParamIndex++;
      }

      if (paymentMode && paymentMode !== 'all') {
        countQuery += ` AND e.payment_mode = $${countParamIndex}`;
        countParams.push(paymentMode);
        countParamIndex++;
      }

      if (memberId && memberId !== 'all') {
        countQuery += ` AND e.created_by = $${countParamIndex}`;
        countParams.push(memberId);
        countParamIndex++;
      }

      if (startDate) {
        countQuery += ` AND e.entry_date >= $${countParamIndex}`;
        countParams.push(startDate);
        countParamIndex++;
      }

      if (endDate) {
        countQuery += ` AND e.entry_date <= $${countParamIndex}`;
        countParams.push(endDate);
        countParamIndex++;
      }

      if (search) {
        countQuery += ` AND (
          e.remarks ILIKE $${countParamIndex} OR 
          e.amount::text ILIKE $${countParamIndex} OR
          e.party_name ILIKE $${countParamIndex} OR
          e.category_name ILIKE $${countParamIndex}
        )`;
        countParams.push(`%${search}%`);
        countParamIndex++;
      }

      const countResult = await app.pg.query(countQuery, countParams);
      const total = parseInt(countResult.rows[0].total);

      return reply.send({
        entries: result.rows,
        total,
        limit: parseInt(limit),
        offset: parseInt(offset)
      });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to fetch entries');
      return reply.code(500).send({
        message: 'Failed to fetch entries',
        error: error.message
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

      // Check if user has permission to view cashbooks
      const canView = await hasPermission(app.pg, user.id, 'cashbooks.view');
      if (!canView) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to view cashbooks.' });
      }

      // Check if user is admin
      const roles = await getUserRoles(app.pg, user.id);
      const isAdmin = roles.includes('admin');

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

      // Build query with access check for non-admin users
      let query = `
        SELECT 
          b.id,
          b.name,
          b.description,
          b.currency_code,
          b.created_at,
          b.updated_at,
          b.owner_user_id,
          b.business_id,
          u.email as owner_email,
          ud.first_name as owner_first_name,
          ud.last_name as owner_last_name,
          ud.phone as owner_phone,
          COALESCE(biz.master_wallet_balance, 0) as master_wallet_balance,
          COALESCE(
            (SELECT COUNT(*)::integer
             FROM public.entries e 
             WHERE e.book_id = b.id),
            0
          ) as transaction_count,
          COALESCE(
            (SELECT SUM(CASE 
              WHEN e.entry_type = 'cash_in' THEN e.amount 
              WHEN e.entry_type = 'cash_out' THEN -e.amount 
              ELSE 0 
            END)
            FROM public.entries e 
            WHERE e.book_id = b.id),
            0
          ) as total_balance
        FROM public.books b
        INNER JOIN public.users u ON b.owner_user_id = u.id
        LEFT JOIN public.user_details ud ON u.id = ud.user_id
        LEFT JOIN public.businesses biz ON b.business_id = biz.id
        WHERE b.id = $1
      `;

      const params = [id];

      // For non-admin users, check if they have access to the book (owner or member)
      if (!isAdmin) {
        query += ` AND (
          b.owner_user_id = $2 OR
          EXISTS (
            SELECT 1 FROM public.book_users bu 
            WHERE bu.book_id = b.id AND bu.user_id = $2
          )
        )`;
        params.push(user.id);
        request.log.info({ userId: user.id, email: user.email, bookId: id }, 'Checking book access for non-admin user');
      }

      const result = await app.pg.query(query, params);

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
        businessId: row.business_id || null,
        ownerEmail: row.owner_email,
        ownerName: ownerFullName,
        ownerFirstName: row.owner_first_name || null,
        ownerLastName: row.owner_last_name || null,
        ownerPhone: row.owner_phone || null,
        transactionCount: parseInt(row.transaction_count || '0', 10),
        totalBalance: parseFloat(row.total_balance || '0'),
        masterWalletBalance: parseFloat(row.master_wallet_balance || '0'),
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

  // Update book (rename, update description, etc.)
  app.patch('/books/:id', {
    preValidation: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1 },
          description: { type: 'string' },
          currencyCode: { type: 'string' },
          businessId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Check if user has permission to update cashbooks
      const canUpdate = await hasPermission(app.pg, user.id, 'cashbooks.update');
      if (!canUpdate) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to update cashbooks.' });
      }

      const { id } = request.params;
      const { name, description, currencyCode, businessId } = request.body;

      // Check if book exists and user owns it
      const bookCheck = await app.pg.query(
        'SELECT id, name, owner_user_id FROM public.books WHERE id = $1',
        [id]
      );

      if (bookCheck.rows.length === 0) {
        return reply.code(404).send({ message: 'Book not found' });
      }

      const book = bookCheck.rows[0];
      
      // Check if user owns the book or is admin
      const roles = await getUserRoles(app.pg, user.id);
      const isAdmin = roles.includes('admin');
      
      if (book.owner_user_id !== user.id && !isAdmin) {
        return reply.code(403).send({ message: 'Access denied. You can only update your own books.' });
      }

      // Build update query
      const updates = [];
      const params = [];
      let paramIndex = 1;

      if (name !== undefined) {
        updates.push(`name = $${paramIndex++}`);
        params.push(name);
      }
      if (description !== undefined) {
        updates.push(`description = $${paramIndex++}`);
        params.push(description || null);
      }
      if (currencyCode !== undefined) {
        updates.push(`currency_code = $${paramIndex++}`);
        params.push(currencyCode);
      }
      if (businessId !== undefined) {
        // Verify business exists if businessId is provided
        if (businessId) {
          const businessCheck = await app.pg.query(
            'SELECT id FROM public.businesses WHERE id = $1',
            [businessId]
          );
          if (businessCheck.rows.length === 0) {
            return reply.code(404).send({ message: 'Business not found' });
          }
        }
        updates.push(`business_id = $${paramIndex++}`);
        params.push(businessId || null);
      }

      if (updates.length === 0) {
        return reply.code(400).send({ message: 'No fields to update' });
      }

      updates.push(`updated_at = now()`);
      params.push(id);

      const query = `
        UPDATE public.books
        SET ${updates.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING id, name, description, currency_code, owner_user_id, business_id, created_at, updated_at
      `;

      const result = await app.pg.query(query, params);
      const updatedBook = result.rows[0];

      return reply.send({
        success: true,
        book: {
          id: updatedBook.id,
          name: updatedBook.name,
          description: updatedBook.description,
          currencyCode: updatedBook.currency_code,
          ownerId: updatedBook.owner_user_id,
          businessId: updatedBook.business_id,
          createdAt: updatedBook.created_at,
          updatedAt: updatedBook.updated_at,
        },
      });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to update book');
      return reply.code(500).send({ 
        message: 'Failed to update book', 
        error: error.message 
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

      // Check if user has permission to view cashbooks
      const canView = await hasPermission(app.pg, user.id, 'cashbooks.view');
      if (!canView) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to view cashbooks.' });
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

      // Get book owner info
      const bookResult = await app.pg.query(
        `SELECT 
          b.owner_user_id,
          u.email as owner_email,
          u.status as owner_status,
          ud.first_name as owner_first_name,
          ud.last_name as owner_last_name,
          ud.phone as owner_phone,
          b.created_at as owner_added_at
        FROM public.books b
        INNER JOIN public.users u ON b.owner_user_id = u.id
        LEFT JOIN public.user_details ud ON u.id = ud.user_id
        WHERE b.id = $1`,
        [bookId]
      );

      const book = bookResult.rows[0];
      const ownerId = book?.owner_user_id;

      // Get members from book_users table
      const membersResult = await app.pg.query(
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

      // Combine owner and members, ensuring owner is first and not duplicated
      const memberIds = new Set();
      const users = [];

      // Add owner first if exists
      if (ownerId && book) {
        const ownerFullName = [book.owner_first_name, book.owner_last_name].filter(Boolean).join(' ').trim() || book.owner_email?.split('@')[0] || 'Unknown';
        users.push({
          id: ownerId,
          email: book.owner_email,
          name: ownerFullName,
          firstName: book.owner_first_name || null,
          lastName: book.owner_last_name || null,
          phone: book.owner_phone || null,
          status: book.owner_status,
          addedAt: book.owner_added_at,
          isOwner: true,
        });
        memberIds.add(ownerId);
      }

      // Add other members (excluding owner if they're also in book_users)
      membersResult.rows.forEach((row) => {
        if (!memberIds.has(row.id)) {
          const fullName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || row.email?.split('@')[0] || 'Unknown';
          users.push({
            id: row.id,
            email: row.email,
            name: fullName,
            firstName: row.first_name || null,
            lastName: row.last_name || null,
            phone: row.phone || null,
            status: row.status,
            addedAt: row.added_at,
            isOwner: false,
          });
          memberIds.add(row.id);
        }
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

      // Check if user has permission to update cashbooks (needed to add members)
      const canUpdate = await hasPermission(app.pg, user.id, 'cashbooks.update');
      if (!canUpdate) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to manage book members.' });
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

      // Check if user has permission to update cashbooks (needed to add members)
      const canUpdate = await hasPermission(app.pg, user.id, 'cashbooks.update');
      if (!canUpdate) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to manage book members.' });
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

  // Delete book/cashbook (admin only)
  app.delete('/books/:id', {
    preValidation: [app.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Check if user has permission to delete cashbooks
      const canDelete = await hasPermission(app.pg, user.id, 'cashbooks.delete');
      if (!canDelete) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to delete cashbooks.' });
      }

      const { id } = request.params;

      // Check if book exists
      const existing = await app.pg.query(
        'SELECT id, name FROM public.books WHERE id = $1',
        [id]
      );

      if (existing.rows.length === 0) {
        return reply.code(404).send({ message: 'Book not found' });
      }

      // Delete book (cascade will handle related records like book_users, transactions, etc.)
      await app.pg.query('DELETE FROM public.books WHERE id = $1', [id]);

      return reply.send({
        success: true,
        message: 'Book deleted successfully',
      });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
        code: error.code,
        detail: error.detail
      }, 'Failed to delete book');
      
      const errorMessage = error.detail || error.message || 'Failed to delete book';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Get report preview - must be before /books/:id/reports/download
  app.get('/books/:id/reports/preview', {
    preValidation: [app.authenticate],
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Check if user has permission to view cashbooks
      const canView = await hasPermission(app.pg, user.id, 'cashbooks.view');
      if (!canView) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to view reports.' });
      }

      const { id: bookId } = request.params;
      const { 
        duration,
        types,
        parties,
        members,
        paymentModes,
        categories,
        search,
        filterType = 'all'
      } = request.query;

      // Verify book exists and user has access
      const bookResult = await app.pg.query(
        `SELECT b.id, b.name, b.owner_user_id
         FROM public.books b
         WHERE b.id = $1`,
        [bookId]
      );

      if (bookResult.rows.length === 0) {
        return reply.code(404).send({ message: 'Book not found' });
      }

      const book = bookResult.rows[0];

      // Check if user is admin or has access to this book
      const roles = await getUserRoles(app.pg, user.id);
      const isAdmin = roles.includes('admin');

      if (!isAdmin && book.owner_user_id !== user.id) {
        const memberCheck = await app.pg.query(
          'SELECT 1 FROM public.book_users WHERE book_id = $1 AND user_id = $2',
          [bookId, user.id]
        );

        if (memberCheck.rows.length === 0) {
          return reply.code(403).send({ message: 'Access denied. You do not have access to this book.' });
        }
      }

      // Build date range based on duration
      let startDate = null;
      let endDate = null;
      const now = new Date();
      
      if (duration && duration !== 'all') {
        switch (duration) {
          case 'today':
            startDate = new Date(now.setHours(0, 0, 0, 0)).toISOString().split('T')[0];
            endDate = new Date().toISOString().split('T')[0];
            break;
          case 'week':
            const weekAgo = new Date(now);
            weekAgo.setDate(weekAgo.getDate() - 7);
            startDate = weekAgo.toISOString().split('T')[0];
            endDate = new Date().toISOString().split('T')[0];
            break;
          case 'month':
            const monthAgo = new Date(now);
            monthAgo.setMonth(monthAgo.getMonth() - 1);
            startDate = monthAgo.toISOString().split('T')[0];
            endDate = new Date().toISOString().split('T')[0];
            break;
          case 'year':
            const yearAgo = new Date(now);
            yearAgo.setFullYear(yearAgo.getFullYear() - 1);
            startDate = yearAgo.toISOString().split('T')[0];
            endDate = new Date().toISOString().split('T')[0];
            break;
        }
      }

      // Build query with filters
      let query = `
        SELECT 
          e.id,
          e.entry_type,
          e.amount,
          e.party_name,
          e.category_name,
          e.payment_mode,
          e.remarks,
          e.entry_date,
          e.entry_time,
          e.created_at,
          e.created_by,
          COALESCE(ud.first_name || ' ' || ud.last_name, u.email, 'Unknown') as created_by_name,
          u.email as created_by_email,
          CASE WHEN EXISTS (
            SELECT 1 FROM public.entry_attachments ea WHERE ea.entry_id = e.id
          ) THEN true ELSE false END as has_attachment
        FROM public.entries e
        LEFT JOIN public.users u ON e.created_by = u.id
        LEFT JOIN public.user_details ud ON u.id = ud.user_id
        WHERE e.book_id = $1
      `;
      const queryParams = [bookId];
      let paramIndex = 2;

      if (types && types !== 'all') {
        query += ` AND e.entry_type = $${paramIndex}`;
        queryParams.push(types);
        paramIndex++;
      }

      if (parties && parties !== 'all') {
        query += ` AND e.party_id = $${paramIndex}`;
        queryParams.push(parties);
        paramIndex++;
      }

      if (categories && categories !== 'all') {
        query += ` AND e.category_id = $${paramIndex}`;
        queryParams.push(categories);
        paramIndex++;
      }

      if (paymentModes) {
        const modes = paymentModes.split(',');
        if (modes.length > 0 && !modes.includes('all')) {
          query += ` AND e.payment_mode = ANY($${paramIndex})`;
          queryParams.push(modes);
          paramIndex++;
        }
      }

      if (members && members !== 'all') {
        query += ` AND e.created_by = $${paramIndex}`;
        queryParams.push(members);
        paramIndex++;
      }

      if (startDate) {
        query += ` AND e.entry_date >= $${paramIndex}`;
        queryParams.push(startDate);
        paramIndex++;
      }

      if (endDate) {
        query += ` AND e.entry_date <= $${paramIndex}`;
        queryParams.push(endDate);
        paramIndex++;
      }

      if (search) {
        query += ` AND (
          e.remarks ILIKE $${paramIndex} OR 
          e.amount::text ILIKE $${paramIndex} OR
          e.party_name ILIKE $${paramIndex} OR
          e.category_name ILIKE $${paramIndex}
        )`;
        queryParams.push(`%${search}%`);
        paramIndex++;
      }

      // Apply filter type grouping
      if (filterType === 'day') {
        query += ` ORDER BY e.entry_date DESC, e.entry_time DESC`;
      } else if (filterType === 'party') {
        query += ` ORDER BY e.party_name, e.entry_date DESC, e.entry_time DESC`;
      } else if (filterType === 'category') {
        query += ` ORDER BY e.category_name, e.entry_date DESC, e.entry_time DESC`;
      } else if (filterType === 'payment_mode') {
        query += ` ORDER BY e.payment_mode, e.entry_date DESC, e.entry_time DESC`;
      } else {
        query += ` ORDER BY e.entry_date DESC, e.entry_time DESC`;
      }

      // First, get ALL entries for the book (no filters) to calculate running balance correctly
      // This ensures balance is calculated from all entries chronologically, not just filtered ones
      const allEntriesQuery = `
        SELECT 
          e.id,
          e.entry_type,
          e.amount,
          e.entry_date,
          e.entry_time,
          e.created_at,
          SUM(
            CASE 
              WHEN e.entry_type = 'cash_in' THEN e.amount
              WHEN e.entry_type = 'cash_out' THEN -e.amount
              ELSE 0
            END
          ) OVER (
            PARTITION BY e.book_id 
            ORDER BY e.entry_date ASC, e.entry_time ASC, e.created_at ASC
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) as balance
        FROM public.entries e
        WHERE e.book_id = $1
        ORDER BY e.entry_date ASC, e.entry_time ASC, e.created_at ASC
      `;
      
      const allEntriesResult = await app.pg.query(allEntriesQuery, [bookId]);
      const balanceMap = new Map();
      allEntriesResult.rows.forEach(entry => {
        balanceMap.set(entry.id, entry.balance);
      });

      // Now get filtered entries for display
      const result = await app.pg.query(query, queryParams);
      const entries = result.rows;

      // Calculate summary
      const totalCashIn = entries
        .filter(e => e.entry_type === 'cash_in')
        .reduce((sum, e) => sum + parseFloat(e.amount), 0);
      
      const totalCashOut = entries
        .filter(e => e.entry_type === 'cash_out')
        .reduce((sum, e) => sum + parseFloat(e.amount), 0);
      
      const finalBalance = totalCashIn - totalCashOut;

      let processedEntries = [];
      let runningBalance = 0;

      // Group and summarize based on filter type
      if (filterType === 'day') {
        // Group by date
        const groupedByDate = {};
        entries.forEach(entry => {
          const dateKey = entry.entry_date;
          if (!groupedByDate[dateKey]) {
            groupedByDate[dateKey] = { cashIn: 0, cashOut: 0, date: dateKey };
          }
          if (entry.entry_type === 'cash_in') {
            groupedByDate[dateKey].cashIn += parseFloat(entry.amount);
          } else {
            groupedByDate[dateKey].cashOut += parseFloat(entry.amount);
          }
        });
        
        processedEntries = Object.values(groupedByDate).map((group) => {
          runningBalance += group.cashIn - group.cashOut;
          return {
            entry_date: group.date,
            cash_in: group.cashIn,
            cash_out: group.cashOut,
            balance: runningBalance,
            isSummary: true
          };
        });
      } else if (filterType === 'party') {
        // Group by party
        const groupedByParty = {};
        entries.forEach(entry => {
          const partyKey = entry.party_name || 'Unknown';
          if (!groupedByParty[partyKey]) {
            groupedByParty[partyKey] = { cashIn: 0, cashOut: 0, party: partyKey };
          }
          if (entry.entry_type === 'cash_in') {
            groupedByParty[partyKey].cashIn += parseFloat(entry.amount);
          } else {
            groupedByParty[partyKey].cashOut += parseFloat(entry.amount);
          }
        });
        
        processedEntries = Object.values(groupedByParty).map((group) => {
          runningBalance += group.cashIn - group.cashOut;
          return {
            party_name: group.party,
            cash_in: group.cashIn,
            cash_out: group.cashOut,
            balance: runningBalance,
            isSummary: true
          };
        });
      } else if (filterType === 'category') {
        // Group by category
        const groupedByCategory = {};
        entries.forEach(entry => {
          const categoryKey = entry.category_name || 'Unknown';
          if (!groupedByCategory[categoryKey]) {
            groupedByCategory[categoryKey] = { cashIn: 0, cashOut: 0, category: categoryKey };
          }
          if (entry.entry_type === 'cash_in') {
            groupedByCategory[categoryKey].cashIn += parseFloat(entry.amount);
          } else {
            groupedByCategory[categoryKey].cashOut += parseFloat(entry.amount);
          }
        });
        
        processedEntries = Object.values(groupedByCategory).map((group) => {
          runningBalance += group.cashIn - group.cashOut;
          return {
            category_name: group.category,
            cash_in: group.cashIn,
            cash_out: group.cashOut,
            balance: runningBalance,
            isSummary: true
          };
        });
      } else if (filterType === 'payment_mode') {
        // Group by payment mode
        const groupedByMode = {};
        entries.forEach(entry => {
          const modeKey = entry.payment_mode || 'Unknown';
          if (!groupedByMode[modeKey]) {
            groupedByMode[modeKey] = { cashIn: 0, cashOut: 0, mode: modeKey };
          }
          if (entry.entry_type === 'cash_in') {
            groupedByMode[modeKey].cashIn += parseFloat(entry.amount);
          } else {
            groupedByMode[modeKey].cashOut += parseFloat(entry.amount);
          }
        });
        
        processedEntries = Object.values(groupedByMode).map((group) => {
          runningBalance += group.cashIn - group.cashOut;
          return {
            payment_mode: group.mode,
            cash_in: group.cashIn,
            cash_out: group.cashOut,
            balance: runningBalance,
            isSummary: true
          };
        });
      } else {
        // All entries - show individual entries with running balance
        // Use the balance from balanceMap which was calculated from ALL entries chronologically
        processedEntries = entries.map(entry => ({
          ...entry,
          balance: balanceMap.get(entry.id) || 0,
          hasAttachment: entry.has_attachment,
          isSummary: false
        }));
      }

      // Get user details for generated by
      const userDetails = await app.pg.query(
        `SELECT 
          COALESCE(ud.first_name || ' ' || ud.last_name, u.email) as name, 
          u.email,
          ud.phone
         FROM public.users u
         LEFT JOIN public.user_details ud ON u.id = ud.user_id
         WHERE u.id = $1`,
        [user.id]
      );

      const userDetail = userDetails.rows[0];
      let generatedBy = userDetail?.name || user.email;
      if (userDetail?.phone) {
        generatedBy += ` (+${userDetail.phone})`;
      }

      return reply.send({
        book: {
          id: book.id,
          name: book.name
        },
        entries: processedEntries,
        totalEntries: entries.length,
        summary: {
          totalCashIn,
          totalCashOut,
          finalBalance
        },
        generatedBy,
        generatedAt: new Date().toISOString(),
        filterType
      });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to generate report preview');
      return reply.code(500).send({
        message: 'Failed to generate report preview',
        error: error.message
      });
    }
  });

  // Download report (PDF or Excel) - returns same data as preview but as downloadable file
  app.get('/books/:id/reports/download', {
    preValidation: [app.authenticate],
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      const canView = await hasPermission(app.pg, user.id, 'cashbooks.view');
      if (!canView) {
        return reply.code(403).send({ message: 'Access denied. You do not have permission to download reports.' });
      }

      const { id: bookId } = request.params;
      const { format = 'pdf' } = request.query;

      // Get the same data as preview endpoint
      // For now, return JSON. PDF/Excel generation can be added later with libraries like pdfkit or exceljs
      const previewRequest = {
        ...request,
        params: { id: bookId },
        query: { ...request.query, format: undefined } // Remove format from query for preview
      };

      // Call preview logic (simplified - in production, extract to shared function)
      // For now, just return JSON that frontend can use
      reply.header('Content-Type', 'application/json');
      reply.header('Content-Disposition', `attachment; filename="report-${new Date().toISOString().split('T')[0]}.json"`);
      
      // Return a message that frontend should use preview endpoint
      return reply.send({ 
        message: 'Use /reports/preview endpoint to get data, then generate PDF/Excel client-side or implement server-side generation',
        previewEndpoint: `/api/books/${bookId}/reports/preview`
      });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to download report');
      return reply.code(500).send({
        message: 'Failed to download report',
        error: error.message
      });
    }
  });

}

module.exports = booksRoutes;

