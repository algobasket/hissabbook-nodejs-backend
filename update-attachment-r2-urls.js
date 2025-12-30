/**
 * Migration script to update entry_attachments.file_path with R2 URLs
 * from payout_requests.proof_filename for entries linked to payout requests
 * 
 * This script updates existing entry attachments that were created before
 * R2 integration was complete, ensuring they use R2 URLs instead of local filenames.
 * 
 * Usage: node update-attachment-r2-urls.js
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'hissabbook',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

async function updateAttachmentR2Urls() {
  const client = await pool.connect();
  
  try {
    console.log('🔍 Finding entry attachments linked to payout requests...');
    
    // Find entry attachments that:
    // 1. Have a file_path that looks like a payout proof (starts with "payout-")
    // 2. Are linked to entries that have remarks containing "Payout Request:"
    // 3. The corresponding payout_request has a proof_filename that's an R2 URL
    const query = `
      SELECT DISTINCT
        ea.id as attachment_id,
        ea.file_path as current_file_path,
        ea.file_name,
        pr.proof_filename as r2_url,
        e.id as entry_id,
        e.remarks
      FROM public.entry_attachments ea
      INNER JOIN public.entries e ON ea.entry_id = e.id
      INNER JOIN public.payout_requests pr ON e.remarks LIKE '%Payout Request: ' || pr.id::text || '%'
      WHERE 
        ea.file_path LIKE 'payout-%'
        AND pr.proof_filename LIKE 'http%'
        AND ea.file_path != pr.proof_filename
      ORDER BY ea.id;
    `;
    
    const result = await client.query(query);
    
    if (result.rows.length === 0) {
      console.log('✅ No entries found that need updating.');
      return;
    }
    
    console.log(`📋 Found ${result.rows.length} entry attachment(s) to update:`);
    result.rows.forEach((row, index) => {
      console.log(`\n${index + 1}. Attachment ID: ${row.attachment_id}`);
      console.log(`   Entry ID: ${row.entry_id}`);
      console.log(`   Current file_path: ${row.current_file_path}`);
      console.log(`   R2 URL: ${row.r2_url}`);
    });
    
    console.log('\n🔄 Updating entry attachments...');
    
    let updatedCount = 0;
    for (const row of result.rows) {
      const updateQuery = `
        UPDATE public.entry_attachments
        SET file_path = $1
        WHERE id = $2
        RETURNING id, file_path;
      `;
      
      const updateResult = await client.query(updateQuery, [row.r2_url, row.attachment_id]);
      
      if (updateResult.rows.length > 0) {
        console.log(`✅ Updated attachment ${row.attachment_id}: ${row.r2_url}`);
        updatedCount++;
      } else {
        console.log(`❌ Failed to update attachment ${row.attachment_id}`);
      }
    }
    
    console.log(`\n✨ Successfully updated ${updatedCount} out of ${result.rows.length} entry attachment(s).`);
    
  } catch (error) {
    console.error('❌ Error updating entry attachments:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run the migration
updateAttachmentR2Urls()
  .then(() => {
    console.log('\n🎉 Migration completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n💥 Migration failed:', error);
    process.exit(1);
  });

