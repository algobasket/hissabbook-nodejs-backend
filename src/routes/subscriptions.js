const { findUserByEmail } = require('../services/userService');

async function subscriptionsRoutes(app) {
  // Get all subscription plans (including inactive for admin)
  app.get('/subscriptions/plans', {
    preValidation: [app.authenticate],
  }, async (request, reply) => {
    try {
      // Check if subscription_plans table exists
      const tableCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'subscription_plans'
        );
      `);

      if (!tableCheck.rows[0]?.exists) {
        request.log.warn('subscription_plans table does not exist. Please run migration 019_create_subscription_system.sql');
        // Return empty plans array instead of error
        return reply.send({ plans: [] });
      }

      // Check if user is admin - if so, return all plans, otherwise only active
      const user = await findUserByEmail(app.pg, request.user.email);
      const { getUserRoles } = require('../services/userService');
      const roles = await getUserRoles(app.pg, user.id);
      const isAdmin = roles.includes('admin');

      const query = isAdmin 
        ? 'SELECT * FROM public.subscription_plans ORDER BY price ASC'
        : 'SELECT * FROM public.subscription_plans WHERE is_active = true ORDER BY price ASC';
      
      const result = await app.pg.query(query);

      const plans = result.rows.map((plan) => ({
        id: plan.id,
        name: plan.name,
        description: plan.description,
        price: parseFloat(plan.price || 0),
        currencyCode: plan.currency_code,
        billingPeriod: plan.billing_period,
        businessLimit: plan.business_limit === -1 ? 'Unlimited' : plan.business_limit,
        membersPerBusinessLimit: plan.members_per_business_limit === -1 ? 'Unlimited' : plan.members_per_business_limit,
        features: plan.features || {},
        isActive: plan.is_active,
        createdAt: plan.created_at,
        updatedAt: plan.updated_at,
      }));

      return reply.send({ plans });
    } catch (error) {
      request.log.error({ err: error, stack: error.stack }, 'Failed to fetch subscription plans');
      return reply.code(500).send({ 
        message: 'Failed to fetch subscription plans',
        error: error.message 
      });
    }
  });

  // Get current business subscription
  app.get('/subscriptions/current', {
    preValidation: [app.authenticate],
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Get selected business ID from query or localStorage (we'll get it from query)
      const businessId = request.query.business_id;
      if (!businessId) {
        return reply.code(400).send({ message: 'Business ID is required' });
      }

      // Verify user has access to this business
      const businessCheck = await app.pg.query(
        `SELECT b.*
         FROM public.businesses b
         WHERE b.id = $2 AND (b.owner_user_id = $1 OR EXISTS (
           SELECT 1 FROM public.books bk 
           WHERE bk.business_id = b.id AND bk.owner_user_id = $1
         ))`,
        [user.id, businessId]
      );

      if (businessCheck.rows.length === 0) {
        return reply.code(403).send({ message: 'Access denied to this business' });
      }

      // Get active subscription for this business
      const subscriptionResult = await app.pg.query(
        `SELECT s.*, sp.name as plan_name, sp.description as plan_description, 
         sp.price, sp.currency_code, sp.billing_period as plan_billing_period,
         sp.business_limit, sp.members_per_business_limit, sp.features
         FROM public.subscribers s
         JOIN public.subscription_plans sp ON s.plan_id = sp.id
         WHERE s.business_id = $1 AND s.status = 'active'
         ORDER BY s.created_at DESC
         LIMIT 1`,
        [businessId]
      );

      if (subscriptionResult.rows.length === 0) {
        // Return default starter plan if no subscription
        const defaultPlan = await app.pg.query(
          "SELECT * FROM public.subscription_plans WHERE name = 'Starter Plan' LIMIT 1"
        );
        
        if (defaultPlan.rows.length > 0) {
          const plan = defaultPlan.rows[0];
          return reply.send({
            subscription: null,
            plan: {
              id: plan.id,
              name: plan.name,
              description: plan.description,
              price: parseFloat(plan.price || 0),
              currencyCode: plan.currency_code,
              billingPeriod: plan.billing_period,
              businessLimit: plan.business_limit === -1 ? 'Unlimited' : plan.business_limit,
              membersPerBusinessLimit: plan.members_per_business_limit === -1 ? 'Unlimited' : plan.members_per_business_limit,
              features: plan.features || {},
            },
            status: 'none',
          });
        }
        
        return reply.send({ subscription: null, plan: null, status: 'none' });
      }

      const sub = subscriptionResult.rows[0];
      const subscription = {
        id: sub.id,
        businessId: sub.business_id,
        planId: sub.plan_id,
        planName: sub.plan_name,
        planDescription: sub.plan_description,
        status: sub.status,
        startDate: sub.start_date,
        endDate: sub.end_date,
        billingPeriod: sub.billing_period,
        autoRenew: sub.auto_renew,
        price: parseFloat(sub.price || 0),
        currencyCode: sub.currency_code,
        businessLimit: sub.business_limit === -1 ? 'Unlimited' : sub.business_limit,
        membersPerBusinessLimit: sub.members_per_business_limit === -1 ? 'Unlimited' : sub.members_per_business_limit,
        features: sub.features || {},
        createdAt: sub.created_at,
        updatedAt: sub.updated_at,
      };

      return reply.send({ subscription, status: sub.status });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to fetch current subscription');
      return reply.code(500).send({ message: 'Failed to fetch current subscription' });
    }
  });

  // Subscribe to a plan
  app.post('/subscriptions/subscribe', {
    preValidation: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['business_id', 'plan_id'],
        properties: {
          business_id: { type: 'string' },
          plan_id: { type: 'string' },
          billing_period: { type: 'string', enum: ['month', 'year'] },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      const { business_id, plan_id, billing_period = 'month' } = request.body;

      // Verify user has access to this business
      const businessCheck = await app.pg.query(
        `SELECT b.* FROM public.businesses b
         WHERE b.id = $1 AND (b.owner_user_id = $2 OR EXISTS (
           SELECT 1 FROM public.books bk 
           WHERE bk.business_id = b.id AND bk.owner_user_id = $2
         ))`,
        [business_id, user.id]
      );

      if (businessCheck.rows.length === 0) {
        return reply.code(403).send({ message: 'Access denied to this business' });
      }

      // Verify plan exists
      const planCheck = await app.pg.query(
        'SELECT * FROM public.subscription_plans WHERE id = $1 AND is_active = true',
        [plan_id]
      );

      if (planCheck.rows.length === 0) {
        return reply.code(404).send({ message: 'Subscription plan not found' });
      }

      const plan = planCheck.rows[0];

      // Calculate end date based on billing period
      const startDate = new Date();
      const endDate = new Date();
      if (billing_period === 'month') {
        endDate.setMonth(endDate.getMonth() + 1);
      } else if (billing_period === 'year') {
        endDate.setFullYear(endDate.getFullYear() + 1);
      }

      // Cancel any existing active subscription
      await app.pg.query(
        `UPDATE public.subscribers 
         SET status = 'cancelled', updated_at = now() 
         WHERE business_id = $1 AND status = 'active'`,
        [business_id]
      );

      // Create new subscription
      const subscriptionResult = await app.pg.query(
        `INSERT INTO public.subscribers 
         (business_id, plan_id, status, start_date, end_date, billing_period, auto_renew)
         VALUES ($1, $2, 'active', $3, $4, $5, true)
         RETURNING *`,
        [business_id, plan_id, startDate, endDate, billing_period]
      );

      const subscription = subscriptionResult.rows[0];

      return reply.code(201).send({
        success: true,
        subscription: {
          id: subscription.id,
          businessId: subscription.business_id,
          planId: subscription.plan_id,
          status: subscription.status,
          startDate: subscription.start_date,
          endDate: subscription.end_date,
          billingPeriod: subscription.billing_period,
          autoRenew: subscription.auto_renew,
        },
        message: 'Successfully subscribed to plan',
      });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to subscribe to plan');
      return reply.code(500).send({ message: 'Failed to subscribe to plan', error: error.message });
    }
  });

  // Cancel subscription
  app.post('/subscriptions/cancel', {
    preValidation: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['business_id'],
        properties: {
          business_id: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      const { business_id } = request.body;

      // Verify user has access to this business
      const businessCheck = await app.pg.query(
        `SELECT b.* FROM public.businesses b
         WHERE b.id = $1 AND (b.owner_user_id = $2 OR EXISTS (
           SELECT 1 FROM public.books bk 
           WHERE bk.business_id = b.id AND bk.owner_user_id = $2
         ))`,
        [business_id, user.id]
      );

      if (businessCheck.rows.length === 0) {
        return reply.code(403).send({ message: 'Access denied to this business' });
      }

      // Cancel active subscription
      const result = await app.pg.query(
        `UPDATE public.subscribers 
         SET status = 'cancelled', updated_at = now() 
         WHERE business_id = $1 AND status = 'active'
         RETURNING *`,
        [business_id]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ message: 'No active subscription found' });
      }

      return reply.send({
        success: true,
        message: 'Subscription cancelled successfully',
      });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to cancel subscription');
      return reply.code(500).send({ message: 'Failed to cancel subscription', error: error.message });
    }
  });

  // Update subscription plan (admin only)
  app.put('/subscriptions/plans/:id', {
    preValidation: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          price: { type: 'number' },
          billingPeriod: { type: 'string', enum: ['month', 'year'] },
          businessLimit: { type: 'number' },
          membersPerBusinessLimit: { type: 'number' },
          features: { type: 'object' },
          isActive: { type: 'boolean' },
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
      const { getUserRoles } = require('../services/userService');
      const roles = await getUserRoles(app.pg, user.id);
      const isAdmin = roles.includes('admin');

      if (!isAdmin) {
        return reply.code(403).send({ message: 'Access denied. Admin role required.' });
      }

      const { id } = request.params;
      const { name, description, price, billingPeriod, businessLimit, membersPerBusinessLimit, features, isActive } = request.body;

      // Build update query dynamically
      const updates = [];
      const values = [];
      let paramIndex = 1;

      if (name !== undefined) {
        updates.push(`name = $${paramIndex++}`);
        values.push(name);
      }
      if (description !== undefined) {
        updates.push(`description = $${paramIndex++}`);
        values.push(description);
      }
      if (price !== undefined) {
        updates.push(`price = $${paramIndex++}`);
        values.push(price);
      }
      if (billingPeriod !== undefined) {
        updates.push(`billing_period = $${paramIndex++}`);
        values.push(billingPeriod);
      }
      if (businessLimit !== undefined) {
        updates.push(`business_limit = $${paramIndex++}`);
        values.push(businessLimit);
      }
      if (membersPerBusinessLimit !== undefined) {
        updates.push(`members_per_business_limit = $${paramIndex++}`);
        values.push(membersPerBusinessLimit);
      }
      if (features !== undefined) {
        updates.push(`features = $${paramIndex++}::jsonb`);
        values.push(JSON.stringify(features));
      }
      if (isActive !== undefined) {
        updates.push(`is_active = $${paramIndex++}`);
        values.push(isActive);
      }

      if (updates.length === 0) {
        return reply.code(400).send({ message: 'No fields to update' });
      }

      updates.push(`updated_at = now()`);
      values.push(id);

      const query = `
        UPDATE public.subscription_plans
        SET ${updates.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING *
      `;

      const result = await app.pg.query(query, values);

      if (result.rows.length === 0) {
        return reply.code(404).send({ message: 'Subscription plan not found' });
      }

      const plan = result.rows[0];

      return reply.send({
        success: true,
        plan: {
          id: plan.id,
          name: plan.name,
          description: plan.description,
          price: parseFloat(plan.price || 0),
          currencyCode: plan.currency_code,
          billingPeriod: plan.billing_period,
          businessLimit: plan.business_limit === -1 ? 'Unlimited' : plan.business_limit,
          membersPerBusinessLimit: plan.members_per_business_limit === -1 ? 'Unlimited' : plan.members_per_business_limit,
          features: plan.features || {},
          isActive: plan.is_active,
          createdAt: plan.created_at,
          updatedAt: plan.updated_at,
        },
      });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to update subscription plan');
      return reply.code(500).send({ message: 'Failed to update subscription plan', error: error.message });
    }
  });

  // Get all subscribers (admin only)
  app.get('/subscriptions/subscribers', {
    preValidation: [app.authenticate],
  }, async (request, reply) => {
    try {
      const user = await findUserByEmail(app.pg, request.user.email);
      if (!user) {
        return reply.code(404).send({ message: 'User not found' });
      }

      // Check if user is admin
      const { getUserRoles } = require('../services/userService');
      const roles = await getUserRoles(app.pg, user.id);
      const isAdmin = roles.includes('admin');

      if (!isAdmin) {
        return reply.code(403).send({ message: 'Access denied. Admin role required.' });
      }

      const result = await app.pg.query(
        `SELECT 
          s.id,
          s.business_id,
          b.name as business_name,
          s.plan_id,
          sp.name as plan_name,
          s.status,
          s.start_date,
          s.end_date,
          s.billing_period,
          s.auto_renew,
          s.created_at,
          s.updated_at
         FROM public.subscribers s
         JOIN public.businesses b ON s.business_id = b.id
         JOIN public.subscription_plans sp ON s.plan_id = sp.id
         ORDER BY s.created_at DESC`
      );

      const subscribers = result.rows.map((sub) => ({
        id: sub.id,
        businessId: sub.business_id,
        businessName: sub.business_name,
        planId: sub.plan_id,
        planName: sub.plan_name,
        status: sub.status,
        startDate: sub.start_date,
        endDate: sub.end_date,
        billingPeriod: sub.billing_period,
        autoRenew: sub.auto_renew,
        createdAt: sub.created_at,
        updatedAt: sub.updated_at,
      }));

      return reply.send({ subscribers });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to fetch subscribers');
      return reply.code(500).send({ message: 'Failed to fetch subscribers' });
    }
  });
}

module.exports = subscriptionsRoutes;

