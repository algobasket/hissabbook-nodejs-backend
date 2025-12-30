// Blog Posts Routes for Admin Panel

const { findUserByEmail, getUserRoles } = require('../services/userService');

async function blogPostsRoutes(app) {
  // Get all blog posts
  app.get('/blog-posts', {
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

      // Check if blog_posts table exists
      const tableCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'blog_posts'
        );
      `);

      if (!tableCheck.rows[0]?.exists) {
        return reply.send({ blogPosts: [] });
      }

      // Get all blog posts ordered by created_at DESC
      const result = await app.pg.query(
        `SELECT 
          bp.id,
          bp.title,
          bp.description,
          bp.category,
          bp.created_at,
          bp.updated_at,
          u.email as created_by_email
         FROM public.blog_posts bp
         LEFT JOIN public.users u ON bp.created_by = u.id
         ORDER BY bp.created_at DESC`
      );

      const blogPosts = result.rows.map((row) => ({
        id: row.id,
        title: row.title,
        description: row.description || '',
        category: row.category || '',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        createdBy: row.created_by_email || null,
      }));

      return reply.send({ blogPosts });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to fetch blog posts');
      return reply.code(500).send({ 
        message: 'Failed to fetch blog posts', 
        error: error.message 
      });
    }
  });

  // Create blog post
  app.post('/blog-posts', {
    preValidation: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['title', 'description'],
        properties: {
          title: { type: 'string', minLength: 1 },
          description: { type: 'string', minLength: 1 },
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

      const { title, description, category } = request.body;

      // Check if blog_posts table exists
      const tableCheck = await app.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'blog_posts'
        );
      `);

      if (!tableCheck.rows[0]?.exists) {
        return reply.code(500).send({ message: 'Blog posts table does not exist. Please run migration.' });
      }

      // Insert new blog post
      const result = await app.pg.query(
        `INSERT INTO public.blog_posts (title, description, category, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING id, title, description, category, created_at, updated_at`,
        [title, description, category || null, user.id]
      );

      return reply.code(201).send({ 
        blogPost: {
          id: result.rows[0].id,
          title: result.rows[0].title,
          description: result.rows[0].description || '',
          category: result.rows[0].category || '',
          createdAt: result.rows[0].created_at,
          updatedAt: result.rows[0].updated_at,
          createdBy: user.email,
        },
        message: 'Blog post created successfully'
      });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to create blog post');
      return reply.code(500).send({ 
        message: 'Failed to create blog post', 
        error: error.message 
      });
    }
  });

  // Update blog post
  app.put('/blog-posts/:id', {
    preValidation: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['title', 'description'],
        properties: {
          title: { type: 'string', minLength: 1 },
          description: { type: 'string', minLength: 1 },
          category: { type: 'string' },
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

      const { id } = request.params;
      const { title, description, category } = request.body;

      // Check if blog post exists
      const existing = await app.pg.query(
        `SELECT id FROM public.blog_posts WHERE id = $1`,
        [id]
      );

      if (existing.rows.length === 0) {
        return reply.code(404).send({ message: 'Blog post not found' });
      }

      // Update blog post
      const result = await app.pg.query(
        `UPDATE public.blog_posts
         SET title = $1, description = $2, category = $4, updated_at = now()
         WHERE id = $3
         RETURNING id, title, description, category, created_at, updated_at`,
        [title, description, id, category || null]
      );

      return reply.send({ 
        blogPost: {
          id: result.rows[0].id,
          title: result.rows[0].title,
          description: result.rows[0].description || '',
          category: result.rows[0].category || '',
          createdAt: result.rows[0].created_at,
          updatedAt: result.rows[0].updated_at,
        },
        message: 'Blog post updated successfully'
      });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to update blog post');
      return reply.code(500).send({ 
        message: 'Failed to update blog post', 
        error: error.message 
      });
    }
  });

  // Delete blog post
  app.delete('/blog-posts/:id', {
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

      // Check if blog post exists
      const existing = await app.pg.query(
        `SELECT id FROM public.blog_posts WHERE id = $1`,
        [id]
      );

      if (existing.rows.length === 0) {
        return reply.code(404).send({ message: 'Blog post not found' });
      }

      // Delete blog post
      await app.pg.query(
        `DELETE FROM public.blog_posts WHERE id = $1`,
        [id]
      );

      return reply.send({ 
        success: true,
        message: 'Blog post deleted successfully'
      });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to delete blog post');
      return reply.code(500).send({ 
        message: 'Failed to delete blog post', 
        error: error.message 
      });
    }
  });
}

module.exports = blogPostsRoutes;

