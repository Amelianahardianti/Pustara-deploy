#!/usr/bin/env node
/**
 * Test which reviews query is actually executing
 */

const db = require('./config/database');

async function testQueries() {
  try {
    console.log('\n=== TESTING REVIEWS QUERIES ===\n');

    await db.initializeDatabase();
    console.log('✅ Database initialized\n');

    // Test 1: Try the PRIMARY query (with JOINs)
    console.log('1. PRIMARY QUERY (with JOINs):');
    const primarySql = `SELECT r.id AS review_id, r.*,
        COALESCE(u.username, u.display_name) AS username,
        u.display_name,
        u.avatar_url,
        b.id AS book_id, b.title AS book_title, b.authors, b.cover_url
      FROM reviews r
      LEFT JOIN users u ON r.user_id = u.id
      LEFT JOIN books b ON r.book_id = b.id
      WHERE (b.is_active IS NULL OR b.is_active = true)
      ORDER BY COALESCE(r.created_at, r.created_at_utc, r.created) DESC
      LIMIT $1`;

    try {
      const primaryResult = await db.executeQuery(primarySql, [2]);
      const primaryRows = primaryResult?.rows || primaryResult || [];
      console.log(`   ✅ Query executed successfully`);
      console.log(`   - Rows returned: ${primaryRows.length}`);
      if (primaryRows.length > 0) {
        const row = primaryRows[0];
        console.log(`   - Sample row keys: ${Object.keys(row).sort().join(', ')}`);
        console.log(`   - display_name present? ${row.display_name ? '✅ YES' : '❌ NO'}`);
        console.log(`   - avatar_url present? ${row.avatar_url !== undefined ? '✅ YES' : '❌ NO'}`);
        console.log(`   - book_title present? ${row.book_title ? '✅ YES' : '❌ NO'}`);
        console.log(`   - cover_url present? ${row.cover_url !== undefined ? '✅ YES' : '❌ NO'}`);
      }
    } catch (err) {
      console.log(`   ❌ Query FAILED: ${err.message}`);
    }
    console.log();

    // Test 2: Try the FALLBACK query (without JOINs)
    console.log('2. FALLBACK QUERY (reviews only):');
    const fallbackSql = `SELECT * FROM reviews ORDER BY created_at DESC LIMIT $1`;

    try {
      const fallbackResult = await db.executeQuery(fallbackSql, [2]);
      const fallbackRows = fallbackResult?.rows || fallbackResult || [];
      console.log(`   ✅ Query executed successfully`);
      console.log(`   - Rows returned: ${fallbackRows.length}`);
      if (fallbackRows.length > 0) {
        const row = fallbackRows[0];
        console.log(`   - Sample row keys: ${Object.keys(row).sort().join(', ')}`);
        console.log(`   - display_name present? ${row.display_name ? '✅ YES' : '❌ NO'}`);
        console.log(`   - avatar_url present? ${row.avatar_url !== undefined ? '✅ YES' : '❌ NO'}`);
        console.log(`   - book_title present? ${row.book_title ? '✅ YES' : '❌ NO'}`);
        console.log(`   - cover_url present? ${row.cover_url !== undefined ? '✅ YES' : '❌ NO'}`);
      }
    } catch (err) {
      console.log(`   ❌ Query FAILED: ${err.message}`);
    }
    console.log();

    // Test 3: Call the actual controller endpoint logic
    console.log('3. ACTUAL CONTROLLER RESPONSE:');
    try {
      const limit = Math.min(2, 50);
      let rows = [];
      try {
        console.log('   Attempting primary query...');
        rows = await db.executeQuery(primarySql, [limit]);
        rows = rows?.rows || rows || [];
        console.log(`   ✅ Primary query succeeded, returned ${rows.length} rows`);
      } catch (innerErr) {
        console.log(`   ❌ Primary query failed: ${innerErr.message}`);
        console.log('   Falling back to simple query...');
        try {
          rows = await db.executeQuery(fallbackSql, [limit]);
          rows = rows?.rows || rows || [];
          console.log(`   ✅ Fallback query succeeded, returned ${rows.length} rows`);
        } catch (fallbackErr) {
          throw fallbackErr;
        }
      }

      // Map response like controller does
      const reviews = rows.map((row) => {
        const text = row.review_text ?? row.body ?? row.text ?? row.content ?? '';
        const timeVal = row.created_at ?? row.created_at_utc ?? row.created ?? null;
        const authors = row.authors ?? row.book_authors ?? null;
        return {
          review_id: String(row.review_id || row.id || ''),
          user: String(row.display_name || row.username || row.name || ''),
          avatar_url: row.avatar_url || row.user_avatar || null,
          rating: Number(row.rating ?? 0),
          book: String(row.book_title || row.book_title_raw || ''),
          author: Array.isArray(authors) ? (authors[0] || '') : (authors || ''),
          cover_url: row.cover_url || null,
          key: String(row.book_id || row.bookId || row.book_key || ''),
          text: String(text),
          likes: Number(row.likes ?? 0),
          comments: Number(row.comments ?? 0),
          time: timeVal ? new Date(timeVal).toISOString() : null,
        };
      });

      if (reviews.length > 0) {
        const r = reviews[0];
        console.log(`   - Sample response:`);
        console.log(`     user: "${r.user}"`);
        console.log(`     avatar_url: ${r.avatar_url}`);
        console.log(`     book: "${r.book}"`);
        console.log(`     author: "${r.author}"`);
        console.log(`     cover_url: ${r.cover_url}`);
      }
    } catch (err) {
      console.log(`   ❌ Error: ${err.message}`);
    }
    console.log();

    console.log('=== END TEST ===\n');
    process.exit(0);

  } catch (error) {
    console.error('❌ Test error:', error.message || error);
    process.exit(1);
  }
}

testQueries();
