// Dashboard Routes for Admin Panel
// This is used by hissabbook-react-admin (NOT hissabbook-api-system)

const { findUserByEmail, getUserRoles } = require('../services/userService');

async function dashboardRoutes(app) {
  // Get dashboard statistics
  app.get('/dashboard/stats', {
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

      // Get date filter (today or all)
      const dateFilter = request.query.date_filter || 'all';
      const isToday = dateFilter === 'today';

      // Check if payout_requests table exists
      const tableCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'payout_requests'
        );
      `);

      if (!tableCheck.rows[0]?.exists) {
        return reply.send({
          pendingReviews: 0,
          approvedToday: 0,
          exceptions: 0,
        });
      }

      // Get pending reviews count (filter by today if needed)
      let pendingQuery = `
        SELECT COUNT(*)::integer as count
        FROM public.payout_requests
        WHERE status = 'pending'
      `;
      if (isToday) {
        pendingQuery += ` AND DATE(created_at AT TIME ZONE 'UTC') = CURRENT_DATE`;
      }
      const pendingResult = await app.pg.query(pendingQuery);
      const pendingReviews = parseInt(pendingResult.rows[0]?.count || '0', 10);

      // Get approved total amount (today or all time based on filter)
      let approvedTodayQuery = `
        SELECT COALESCE(SUM(amount), 0)::numeric as total
        FROM public.payout_requests
        WHERE status = 'accepted'
      `;
      if (isToday) {
        approvedTodayQuery += ` AND DATE(updated_at AT TIME ZONE 'UTC') = CURRENT_DATE`;
      }
      const approvedTodayResult = await app.pg.query(approvedTodayQuery);
      const approvedToday = parseFloat(approvedTodayResult.rows[0]?.total || '0');

      // Get exceptions count (rejected requests or requests that need attention)
      // For now, we'll count rejected requests as exceptions (filter by today if needed)
      let exceptionsQuery = `
        SELECT COUNT(*)::integer as count
        FROM public.payout_requests
        WHERE status = 'rejected'
      `;
      if (isToday) {
        exceptionsQuery += ` AND DATE(created_at AT TIME ZONE 'UTC') = CURRENT_DATE`;
      }
      const exceptionsResult = await app.pg.query(exceptionsQuery);
      const exceptions = parseInt(exceptionsResult.rows[0]?.count || '0', 10);

      return reply.send({
        pendingReviews,
        approvedToday,
        exceptions,
      });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
        code: error.code,
        detail: error.detail
      }, 'Failed to fetch dashboard statistics');
      
      const errorMessage = error.detail || error.message || 'Failed to fetch dashboard statistics';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Get business statistics
  app.get('/dashboard/business-stats', {
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
      const businessesTableCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'businesses'
        );
      `);

      if (!businessesTableCheck.rows[0]?.exists) {
        return reply.send({
          totalBusinesses: 0,
          totalOwners: 0,
          totalPartners: 0,
          totalStaff: 0,
        });
      }

      // Get total businesses
      const businessesResult = await app.pg.query(`
        SELECT COUNT(*)::integer as count
        FROM public.businesses
      `);
      const totalBusinesses = parseInt(businessesResult.rows[0]?.count || '0', 10);

      // Get total owners (distinct business owners)
      const ownersResult = await app.pg.query(`
        SELECT COUNT(DISTINCT owner_user_id)::integer as count
        FROM public.businesses
      `);
      const totalOwners = parseInt(ownersResult.rows[0]?.count || '0', 10);

      // Get total partners (users who own books in businesses - book owners)
      const partnersResult = await app.pg.query(`
        SELECT COUNT(DISTINCT b.owner_user_id)::integer as count
        FROM public.books b
        WHERE b.business_id IS NOT NULL
        AND b.owner_user_id NOT IN (
          SELECT DISTINCT owner_user_id FROM public.businesses
        )
      `);
      const totalPartners = parseInt(partnersResult.rows[0]?.count || '0', 10);

      // Get total staff (users who are members of books via book_users, excluding book owners and business owners)
      const staffResult = await app.pg.query(`
        SELECT COUNT(DISTINCT bu.user_id)::integer as count
        FROM public.book_users bu
        INNER JOIN public.books b ON bu.book_id = b.id
        WHERE b.business_id IS NOT NULL
        AND bu.user_id NOT IN (
          SELECT DISTINCT owner_user_id FROM public.books WHERE business_id IS NOT NULL
        )
        AND bu.user_id NOT IN (
          SELECT DISTINCT owner_user_id FROM public.businesses
        )
      `);
      const totalStaff = parseInt(staffResult.rows[0]?.count || '0', 10);

      return reply.send({
        totalBusinesses,
        totalOwners,
        totalPartners,
        totalStaff,
      });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
        code: error.code,
        detail: error.detail
      }, 'Failed to fetch business statistics');
      
      const errorMessage = error.detail || error.message || 'Failed to fetch business statistics';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Get recent payout requests for Live Payout Queue
  app.get('/dashboard/payout-queue', {
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

      const { status, limit = 10 } = request.query;

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
      const updatedAtField = hasUpdatedAt ? 'pr.updated_at' : 'pr.created_at';

      let query;
      
      if (hasUserId) {
        query = `
          SELECT 
            pr.id,
            pr.amount,
            pr.utr,
            pr.remarks,
            pr.status,
            pr.created_at,
            ${updatedAtField} as updated_at,
            u.email as user_email,
            ud.first_name,
            ud.last_name,
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
            'staff' as user_role
          FROM public.payout_requests pr
        `;
      }

      const params = [];
      if (status && status !== 'all') {
        // Map frontend status to database status
        let dbStatus = status;
        if (status === 'pending review') {
          dbStatus = 'pending';
        }
        query += ' WHERE pr.status = $1';
        params.push(dbStatus);
      }

      query += ` ORDER BY ${updatedAtField} DESC LIMIT $${params.length + 1}`;
      params.push(parseInt(limit, 10));

      const result = await app.pg.query(query, params);

      const payoutRequests = result.rows.map((row) => {
        const fullName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || row.user_email?.split('@')[0] || 'Unknown';
        const requestId = row.id.substring(0, 8).toUpperCase().replace(/-/g, '');

        return {
          id: row.id,
          requestId: `REQ-${requestId}`,
          amount: parseFloat(row.amount || '0'),
          utr: row.utr || '',
          remarks: row.remarks || '',
          status: row.status,
          userEmail: row.user_email,
          userName: fullName,
          userRole: row.user_role || 'staff',
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      });

      return reply.send({ payoutRequests });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
        code: error.code,
        detail: error.detail
      }, 'Failed to fetch payout queue');
      
      const errorMessage = error.detail || error.message || 'Failed to fetch payout queue';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });

  // Get comprehensive dashboard statistics
  app.get('/dashboard/comprehensive-stats', {
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

      // Get date filter (today or all)
      const dateFilter = request.query.date_filter || 'all';
      const isToday = dateFilter === 'today';

      // Get total businesses
      const businessesTableCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'businesses'
        );
      `);

      let totalBusinesses = 0;
      let totalCashbooks = 0;
      let totalManagers = 0;
      let totalStaffs = 0;
      let totalPayoutRequests = 0;
      let totalCashIn = 0;
      let totalCashOut = 0;

      if (businessesTableCheck.rows[0]?.exists) {
        // Total businesses (always show all, not filtered by date)
        const businessesResult = await app.pg.query(`
          SELECT COUNT(*)::integer as count
          FROM public.businesses
        `);
        totalBusinesses = parseInt(businessesResult.rows[0]?.count || '0', 10);

        // Total cashbooks (books) - filter by created_at if today
        const booksTableCheck = await app.pg.query(`
          SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name = 'books'
          );
        `);
        if (booksTableCheck.rows[0]?.exists) {
          let booksQuery = `SELECT COUNT(*)::integer as count FROM public.books`;
          if (isToday) {
            booksQuery += ` WHERE DATE(created_at AT TIME ZONE 'UTC') = CURRENT_DATE`;
          }
          const booksResult = await app.pg.query(booksQuery);
          totalCashbooks = parseInt(booksResult.rows[0]?.count || '0', 10);
        }

        // Total managers (users with 'managers' role OR business owners - they are the same)
        // Count distinct business owners and users with managers role
        try {
          const managersResult = await app.pg.query(`
            SELECT COUNT(DISTINCT user_id)::integer as count
            FROM (
              SELECT DISTINCT owner_user_id as user_id
              FROM public.businesses
              WHERE owner_user_id IS NOT NULL
              
              UNION
              
              SELECT DISTINCT ur.user_id
              FROM public.user_roles ur
              JOIN public.roles r ON ur.role_id = r.id
              WHERE r.name = 'managers'
            ) combined_managers
          `);
          totalManagers = parseInt(managersResult.rows[0]?.count || '0', 10);
          request.log.info({ totalManagers, rowCount: managersResult.rows.length }, 'Managers count query result');
        } catch (error) {
          request.log.error({ err: error, message: error.message }, 'Error counting managers');
          // Fallback: just count business owners
          try {
            const fallbackResult = await app.pg.query(`
              SELECT COALESCE(COUNT(DISTINCT owner_user_id), 0)::integer as count
              FROM public.businesses
              WHERE owner_user_id IS NOT NULL
            `);
            totalManagers = parseInt(fallbackResult.rows[0]?.count || '0', 10);
          } catch (fallbackError) {
            request.log.error({ err: fallbackError }, 'Fallback managers count also failed');
            totalManagers = 0;
          }
        }

        // Total staffs (users with 'staff' role, excluding managers and owners)
        const staffResult = await app.pg.query(`
          SELECT COUNT(DISTINCT ur.user_id)::integer as count
          FROM public.user_roles ur
          JOIN public.roles r ON ur.role_id = r.id
          WHERE r.name = 'staff'
          AND ur.user_id NOT IN (
            SELECT DISTINCT ur2.user_id
            FROM public.user_roles ur2
            JOIN public.roles r2 ON ur2.role_id = r2.id
            WHERE r2.name IN ('managers', 'owner', 'admin')
          )
        `);
        totalStaffs = parseInt(staffResult.rows[0]?.count || '0', 10);
      }

      // Total payout requests - filter by created_at if today
      const payoutRequestsTableCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'payout_requests'
        );
      `);
      if (payoutRequestsTableCheck.rows[0]?.exists) {
        let payoutRequestsQuery = `SELECT COUNT(*)::integer as count FROM public.payout_requests`;
        if (isToday) {
          payoutRequestsQuery += ` WHERE DATE(created_at AT TIME ZONE 'UTC') = CURRENT_DATE`;
        }
        const payoutRequestsResult = await app.pg.query(payoutRequestsQuery);
        totalPayoutRequests = parseInt(payoutRequestsResult.rows[0]?.count || '0', 10);
      }

      // Total cash-in and cash-out from entries table - filter by entry_date if today
      const entriesTableCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'entries'
        );
      `);
      if (entriesTableCheck.rows[0]?.exists) {
        // Total cash-in
        let cashInQuery = `
          SELECT COALESCE(SUM(amount), 0)::numeric as total
          FROM public.entries
          WHERE entry_type = 'cash_in'
        `;
        if (isToday) {
          cashInQuery += ` AND entry_date = CURRENT_DATE`;
        }
        const cashInResult = await app.pg.query(cashInQuery);
        totalCashIn = parseFloat(cashInResult.rows[0]?.total || '0');

        // Total cash-out
        let cashOutQuery = `
          SELECT COALESCE(SUM(amount), 0)::numeric as total
          FROM public.entries
          WHERE entry_type = 'cash_out'
        `;
        if (isToday) {
          cashOutQuery += ` AND entry_date = CURRENT_DATE`;
        }
        const cashOutResult = await app.pg.query(cashOutQuery);
        totalCashOut = parseFloat(cashOutResult.rows[0]?.total || '0');
      }

      return reply.send({
        totalBusinesses,
        totalCashbooks,
        totalManagers,
        totalStaffs,
        totalPayoutRequests,
        totalCashIn,
        totalCashOut,
      });
    } catch (error) {
      request.log.error({ 
        err: error, 
        stack: error.stack,
        message: error.message,
        code: error.code,
        detail: error.detail
      }, 'Failed to fetch comprehensive dashboard statistics');
      
      const errorMessage = error.detail || error.message || 'Failed to fetch comprehensive dashboard statistics';
      return reply.code(500).send({ 
        message: errorMessage, 
        error: error.message,
        code: error.code,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });
}

module.exports = dashboardRoutes;






