// Settings Routes for system-wide settings

const { findUserByEmail, getUserRoles } = require('../services/userService');
const { saveFileToDisk, deleteFileFromDisk } = require('../utils/fileUpload');

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

  // Get site settings (public endpoint for logos)
  app.get('/settings/site/public', async (request, reply) => {
    try {
      // Get site settings from site_settings table (public, no auth required)
      let result;
      try {
        result = await app.pg.query(
          `SELECT 
            small_logo_filename,
            big_logo_filename
           FROM public.site_settings
           LIMIT 1`
        );
      } catch (tableError) {
        // Table doesn't exist yet - return null
        if (tableError.code === '42P01') {
          return reply.send({
            smallLogoUrl: null,
            bigLogoUrl: null,
          });
        }
        throw tableError;
      }

      if (result.rows.length === 0) {
        return reply.send({
          smallLogoUrl: null,
          bigLogoUrl: null,
        });
      }

      const settings = result.rows[0];

      return reply.send({
        smallLogoUrl: settings.small_logo_filename || null,
        bigLogoUrl: settings.big_logo_filename || null,
      });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to fetch site settings (public)');
      return reply.send({ 
        smallLogoUrl: null,
        bigLogoUrl: null,
      });
    }
  });

  // Get site settings
  app.get('/settings/site', {
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

      // Get site settings from site_settings table
      // First check if table exists, if not return empty settings
      let result;
      try {
        result = await app.pg.query(
          `SELECT 
            site_name,
            site_description,
            site_email,
            site_phone,
            site_address,
            site_logo_filename,
            small_logo_filename,
            big_logo_filename,
            google_play_url,
            app_store_url,
            apk_download_url,
            apk_version,
            apk_file_size
           FROM public.site_settings
           LIMIT 1`
        );
      } catch (tableError) {
        // Table doesn't exist yet - return empty settings
        if (tableError.code === '42P01') { // PostgreSQL error code for "relation does not exist"
          request.log.warn({ err: tableError }, 'site_settings table does not exist yet');
          return reply.send({
            siteName: null,
            siteDescription: null,
            siteEmail: null,
            sitePhone: null,
            siteAddress: null,
            siteLogoUrl: null,
            smallLogoUrl: null,
            bigLogoUrl: null,
          });
        }
        throw tableError;
      }

      if (result.rows.length === 0) {
        // Return empty settings if no record exists (this is normal for first time)
        return reply.send({
          siteName: null,
          siteDescription: null,
          siteEmail: null,
          sitePhone: null,
          siteAddress: null,
          siteLogoUrl: null,
          smallLogoUrl: null,
          bigLogoUrl: null,
          googlePlayUrl: null,
          appStoreUrl: null,
          apkDownloadUrl: null,
          apkVersion: null,
          apkFileSize: null,
        });
      }

      const settings = result.rows[0];

      return reply.send({
        siteName: settings.site_name || null,
        siteDescription: settings.site_description || null,
        siteEmail: settings.site_email || null,
        sitePhone: settings.site_phone || null,
        siteAddress: settings.site_address || null,
        siteLogoUrl: settings.site_logo_filename || null,
        smallLogoUrl: settings.small_logo_filename || null,
        bigLogoUrl: settings.big_logo_filename || null,
        googlePlayUrl: settings.google_play_url || null,
        appStoreUrl: settings.app_store_url || null,
        apkDownloadUrl: settings.apk_download_url || null,
        apkVersion: settings.apk_version || null,
        apkFileSize: settings.apk_file_size || null,
      });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to fetch site settings');
      return reply.code(500).send({ 
        message: 'Failed to fetch site settings', 
        error: error.message 
      });
    }
  });

  // Update site settings
  app.put('/settings/site', {
    preValidation: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          siteName: { type: 'string' },
          siteDescription: { type: 'string' },
          siteEmail: { type: 'string' },
          sitePhone: { type: 'string' },
          siteAddress: { type: 'string' },
          siteLogo: { type: 'string' }, // base64 data URL
          smallLogo: { type: 'string' }, // base64 data URL
          bigLogo: { type: 'string' }, // base64 data URL
          googlePlayUrl: { type: 'string' },
          appStoreUrl: { type: 'string' },
          apkDownloadUrl: { type: 'string' },
          apkFile: { type: 'string' }, // base64 data URL for APK upload
          apkVersion: { type: 'string' },
          apkFileSize: { type: 'string' },
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

      const { siteName, siteDescription, siteEmail, sitePhone, siteAddress, siteLogo, smallLogo, bigLogo, googlePlayUrl, appStoreUrl, apkDownloadUrl, apkFile, apkVersion, apkFileSize } = request.body;

      // Handle logo uploads
      let siteLogoFilename = null;
      let smallLogoFilename = null;
      let bigLogoFilename = null;

      if (siteLogo) {
        try {
          const fileInfo = await saveFileToDisk(siteLogo, 'site-logo');
          if (fileInfo) {
            siteLogoFilename = fileInfo.fileName;
          }
        } catch (logoError) {
          request.log.error({ err: logoError }, 'Failed to save site logo');
          // Continue without failing the entire request
        }
      }

      if (smallLogo) {
        try {
          const fileInfo = await saveFileToDisk(smallLogo, 'small-logo');
          if (fileInfo) {
            smallLogoFilename = fileInfo.fileName;
          }
        } catch (logoError) {
          request.log.error({ err: logoError }, 'Failed to save small logo');
          // Continue without failing the entire request
        }
      }

      if (bigLogo) {
        try {
          const fileInfo = await saveFileToDisk(bigLogo, 'big-logo');
          if (fileInfo) {
            bigLogoFilename = fileInfo.fileName;
          }
        } catch (logoError) {
          request.log.error({ err: logoError }, 'Failed to save big logo');
          // Continue without failing the entire request
        }
      }

      // Check if site_settings record exists (needed to check for old APK file)
      const existing = await app.pg.query(
        `SELECT id, apk_download_url FROM public.site_settings LIMIT 1`
      );

      // Handle APK file upload
      let finalApkDownloadUrl = apkDownloadUrl;
      let finalApkFileSize = apkFileSize;

      if (apkFile) {
        try {
          const version = apkVersion || '1.0';
          const customFileName = `hissabbook-v${version.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

          const fileInfo = await saveFileToDisk(apkFile, 'apk', customFileName);
          if (fileInfo) {
            // Calculate file size if not provided
            if (!finalApkFileSize) {
              const sizeInMB = (fileInfo.fileSize / (1024 * 1024)).toFixed(2);
              finalApkFileSize = `${sizeInMB} MB`;
            }

            // Check if this version already exists
            const existingVersion = await app.pg.query(
              `SELECT id FROM public.apk_versions WHERE version = $1`,
              [version]
            );

            if (existingVersion.rows.length > 0) {
              // Update existing version and mark as current
              // First unset all current versions
              await app.pg.query(
                `UPDATE public.apk_versions SET is_current = false WHERE is_current = true`
              );
              // Then update this version and mark as current
              await app.pg.query(
                `UPDATE public.apk_versions 
                 SET filename = $1, file_size = $2, download_url = $3, is_current = true, updated_at = now()
                 WHERE version = $4`,
                [fileInfo.fileName, finalApkFileSize, fileInfo.fileName, version]
              );
            } else {
              // Set all existing versions to not current
              await app.pg.query(
                `UPDATE public.apk_versions SET is_current = false WHERE is_current = true`
              );

              // Insert new version and mark as current
              await app.pg.query(
                `INSERT INTO public.apk_versions (version, filename, file_size, download_url, is_current)
                 VALUES ($1, $2, $3, $4, true)`,
                [version, fileInfo.fileName, finalApkFileSize, fileInfo.fileName]
              );
            }

            // Also update site_settings with current version (for backward compatibility)
            finalApkDownloadUrl = fileInfo.fileName;
          }
        } catch (apkError) {
          request.log.error({ err: apkError }, 'Failed to save APK file');
          return reply.code(400).send({ 
            message: 'Failed to save APK file', 
            error: apkError.message 
          });
        }
      }

      if (existing.rows.length > 0) {
        // Update existing record
        const updateFields = [];
        const updateValues = [];
        let paramIndex = 1;
        const existingId = existing.rows[0].id;

        if (siteName !== undefined) {
          updateFields.push(`site_name = $${paramIndex++}`);
          updateValues.push(siteName || null);
        }
        if (siteDescription !== undefined) {
          updateFields.push(`site_description = $${paramIndex++}`);
          updateValues.push(siteDescription || null);
        }
        if (siteEmail !== undefined) {
          updateFields.push(`site_email = $${paramIndex++}`);
          updateValues.push(siteEmail || null);
        }
        if (sitePhone !== undefined) {
          updateFields.push(`site_phone = $${paramIndex++}`);
          updateValues.push(sitePhone || null);
        }
        if (siteAddress !== undefined) {
          updateFields.push(`site_address = $${paramIndex++}`);
          updateValues.push(siteAddress || null);
        }
        if (siteLogoFilename !== null) {
          updateFields.push(`site_logo_filename = $${paramIndex++}`);
          updateValues.push(siteLogoFilename);
        }
        if (smallLogoFilename !== null) {
          updateFields.push(`small_logo_filename = $${paramIndex++}`);
          updateValues.push(smallLogoFilename);
        }
        if (bigLogoFilename !== null) {
          updateFields.push(`big_logo_filename = $${paramIndex++}`);
          updateValues.push(bigLogoFilename);
        }
        if (googlePlayUrl !== undefined) {
          updateFields.push(`google_play_url = $${paramIndex++}`);
          updateValues.push(googlePlayUrl || null);
        }
        if (appStoreUrl !== undefined) {
          updateFields.push(`app_store_url = $${paramIndex++}`);
          updateValues.push(appStoreUrl || null);
        }
        if (apkDownloadUrl !== undefined || apkFile) {
          updateFields.push(`apk_download_url = $${paramIndex++}`);
          updateValues.push(finalApkDownloadUrl || null);
        }
        if (apkFile && !apkFileSize && finalApkFileSize) {
          // Update file size if APK was uploaded and size wasn't explicitly provided
          updateFields.push(`apk_file_size = $${paramIndex++}`);
          updateValues.push(finalApkFileSize);
        }
        if (apkVersion !== undefined) {
          updateFields.push(`apk_version = $${paramIndex++}`);
          updateValues.push(apkVersion || null);
        }
        if (apkFileSize !== undefined) {
          updateFields.push(`apk_file_size = $${paramIndex++}`);
          updateValues.push(apkFileSize || null);
        }

        if (updateFields.length > 0) {
          updateFields.push(`updated_at = now()`);
          updateValues.push(existingId);

          await app.pg.query(
            `UPDATE public.site_settings 
             SET ${updateFields.join(', ')}
             WHERE id = $${paramIndex}`,
            updateValues
          );
        } else {
          // If only logos were updated, still update the timestamp
          await app.pg.query(
            `UPDATE public.site_settings 
             SET updated_at = now()
             WHERE id = $1`,
            [existingId]
          );
        }
      } else {
        // Insert new record
        await app.pg.query(
          `INSERT INTO public.site_settings (
            site_name, site_description, site_email, site_phone, site_address,
            site_logo_filename, small_logo_filename, big_logo_filename
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            siteName || null,
            siteDescription || null,
            siteEmail || null,
            sitePhone || null,
            siteAddress || null,
            siteLogoFilename,
            smallLogoFilename,
            bigLogoFilename,
          ]
        );
      }

      // Get updated settings to return
      const result = await app.pg.query(
        `SELECT 
          site_name,
          site_description,
          site_email,
          site_phone,
          site_address,
          site_logo_filename,
          google_play_url,
          app_store_url,
          apk_download_url,
          apk_version,
          apk_file_size,
          small_logo_filename,
          big_logo_filename
         FROM public.site_settings
         LIMIT 1`
      );

      const updatedSettings = result.rows[0] || {};

      return reply.send({
        success: true,
        message: 'Site settings updated successfully',
        siteName: updatedSettings.site_name || null,
        siteDescription: updatedSettings.site_description || null,
        siteEmail: updatedSettings.site_email || null,
        sitePhone: updatedSettings.site_phone || null,
        siteAddress: updatedSettings.site_address || null,
        siteLogoUrl: updatedSettings.site_logo_filename || null,
        smallLogoUrl: updatedSettings.small_logo_filename || null,
        bigLogoUrl: updatedSettings.big_logo_filename || null,
        googlePlayUrl: updatedSettings.google_play_url || null,
        appStoreUrl: updatedSettings.app_store_url || null,
        apkDownloadUrl: updatedSettings.apk_download_url || null,
        apkVersion: updatedSettings.apk_version || null,
        apkFileSize: updatedSettings.apk_file_size || null,
      });
    } catch (error) {
      request.log.error({ err: error }, 'Failed to update site settings');
      return reply.code(500).send({ 
        message: 'Failed to update site settings', 
        error: error.message 
      });
    }
  });

  // Get all APK versions
  app.get('/settings/apk-versions', {
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

      // Get all APK versions, ordered by creation date (newest first)
      const result = await app.pg.query(
        `SELECT 
          id,
          version,
          filename,
          file_size,
          download_url,
          is_current,
          created_at,
          updated_at
         FROM public.apk_versions
         ORDER BY created_at DESC`
      );

      // Build download URLs for each version
      // Use request protocol and host to build absolute URLs
      const protocol = request.headers['x-forwarded-proto'] || request.protocol || 'https';
      const host = request.headers.host || 'hissabbook.com';
      const baseUrl = `${protocol}://${host}`;
      
      const versions = result.rows.map(row => ({
        id: row.id,
        version: row.version,
        filename: row.filename,
        fileSize: row.file_size,
        downloadUrl: row.download_url && !row.download_url.startsWith('http') 
          ? `${baseUrl}/backend/uploads/${row.download_url}` 
          : row.download_url,
        isCurrent: row.is_current,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));

      return reply.send({ versions });
    } catch (error) {
      // If table doesn't exist yet, return empty array
      if (error.code === '42P01') {
        return reply.send({ versions: [] });
      }
      request.log.error({ err: error }, 'Failed to fetch APK versions');
      return reply.code(500).send({ 
        message: 'Failed to fetch APK versions', 
        error: error.message 
      });
    }
  });
}

module.exports = settingsRoutes;

