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

      // Get pending reviews count
      const pendingResult = await app.pg.query(
        `SELECT COUNT(*)::integer as count
         FROM public.payout_requests
         WHERE status = 'pending'`
      );
      const pendingReviews = parseInt(pendingResult.rows[0]?.count || '0', 10);

      // Get approved today total amount
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      
      const approvedTodayResult = await app.pg.query(
        `SELECT COALESCE(SUM(amount), 0)::numeric as total
         FROM public.payout_requests
         WHERE status = 'accepted'
         AND DATE(updated_at) = CURRENT_DATE`
      );
      const approvedToday = parseFloat(approvedTodayResult.rows[0]?.total || '0');

      // Get exceptions count (rejected requests or requests that need attention)
      // For now, we'll count rejected requests as exceptions
      const exceptionsResult = await app.pg.query(
        `SELECT COUNT(*)::integer as count
         FROM public.payout_requests
         WHERE status = 'rejected'`
      );
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
}

module.exports = dashboardRoutes;


