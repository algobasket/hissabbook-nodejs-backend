const { v4: uuidv4 } = require('uuid');
const { hashPassword } = require('../utils/password');

async function findUserByEmail(pool, email) {
  const result = await pool.query('SELECT * FROM public.users WHERE email = $1 LIMIT 1', [email.toLowerCase()]);
  return result.rows[0];
}

async function getUserRoles(pool, userId) {
  const result = await pool.query(
    `SELECT r.name 
     FROM public.user_roles ur
     JOIN public.roles r ON ur.role_id = r.id
     WHERE ur.user_id = $1`,
    [userId],
  );
  return result.rows.map((row) => row.name);
}

async function getUserPermissions(pool, userId) {
  const result = await pool.query(
    `SELECT DISTINCT p.code, p.name, p.category
     FROM public.user_roles ur
     JOIN public.role_permissions rp ON ur.role_id = rp.role_id
     JOIN public.permissions p ON rp.permission_id = p.id
     WHERE ur.user_id = $1`,
    [userId],
  );
  return result.rows.map((row) => row.code);
}

async function hasPermission(pool, userId, permissionCode) {
  // Admin always has all permissions
  const roles = await getUserRoles(pool, userId);
  if (roles.includes('admin')) {
    return true;
  }

  const permissions = await getUserPermissions(pool, userId);
  return permissions.includes(permissionCode);
}

async function createUser(pool, { email, password, firstName, lastName, createdBy }) {
  const id = uuidv4();
  const passwordHash = await hashPassword(password);

  const result = await pool.query(
    `INSERT INTO public.users (id, email, password_hash, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, email, status, created_at, updated_at, created_by`,
    [id, email.toLowerCase(), passwordHash, createdBy || null],
  );

  const user = result.rows[0];

  await pool.query(
    `INSERT INTO public.user_details (user_id, first_name, last_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO NOTHING`,
    [user.id, firstName || null, lastName || null],
  );

  return user;
}

async function getUserDetails(pool, userId) {
  const result = await pool.query(
    `SELECT 
      ud.user_id,
      ud.first_name,
      ud.last_name,
      ud.phone,
      ud.upi_id,
      ud.upi_qr_code,
      ud.address,
      ud.metadata
     FROM public.user_details ud
     WHERE ud.user_id = $1`,
    [userId],
  );
  return result.rows[0] || null;
}

async function updateUserDetails(pool, userId, { firstName, lastName, phone, upiId, gstin, address, upiQrCode }) {
  // Get existing details first
  const existing = await getUserDetails(pool, userId);
  
  // Handle metadata
  let metadata = {};
  if (existing?.metadata) {
    // If metadata is already an object, use it; otherwise parse it
    if (typeof existing.metadata === 'object') {
      metadata = { ...existing.metadata };
    } else {
      try {
        metadata = typeof existing.metadata === 'string' ? JSON.parse(existing.metadata) : {};
      } catch {
        metadata = {};
      }
    }
  }
  
  // Update GSTIN in metadata if provided
  if (gstin !== undefined) {
    metadata.gstin = gstin || null;
  }

  // Prepare values for UPSERT
  const finalFirstName = firstName !== undefined ? (firstName || null) : (existing?.first_name || null);
  const finalLastName = lastName !== undefined ? (lastName || null) : (existing?.last_name || null);
  const finalPhone = phone !== undefined ? (phone || null) : (existing?.phone || null);
  const finalUpiId = upiId !== undefined ? (upiId || null) : (existing?.upi_id || null);
  const finalUpiQrCode = upiQrCode !== undefined ? (upiQrCode || null) : (existing?.upi_qr_code || null);
  const finalAddress = address !== undefined ? (address ? JSON.stringify(address) : null) : (existing?.address || null);

  // Use UPSERT to handle both insert and update
  const upsertQuery = `
    INSERT INTO public.user_details (user_id, first_name, last_name, phone, upi_id, upi_qr_code, metadata, address, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
    ON CONFLICT (user_id) DO UPDATE
    SET 
      first_name = COALESCE(EXCLUDED.first_name, user_details.first_name),
      last_name = COALESCE(EXCLUDED.last_name, user_details.last_name),
      phone = COALESCE(EXCLUDED.phone, user_details.phone),
      upi_id = COALESCE(EXCLUDED.upi_id, user_details.upi_id),
      upi_qr_code = COALESCE(EXCLUDED.upi_qr_code, user_details.upi_qr_code),
      metadata = COALESCE(EXCLUDED.metadata::jsonb, user_details.metadata),
      address = COALESCE(EXCLUDED.address::jsonb, user_details.address),
      updated_at = now()
    RETURNING user_id, first_name, last_name, phone, upi_id, upi_qr_code, address, metadata
  `;

  const result = await pool.query(upsertQuery, [
    userId,
    finalFirstName,
    finalLastName,
    finalPhone,
    finalUpiId,
    finalUpiQrCode,
    JSON.stringify(metadata),
    finalAddress,
  ]);

  return result.rows[0] || null;
}

module.exports = {
  findUserByEmail,
  createUser,
  getUserRoles,
  getUserPermissions,
  hasPermission,
  getUserDetails,
  updateUserDetails,
};

