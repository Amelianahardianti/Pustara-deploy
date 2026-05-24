#!/usr/bin/env node
/**
 * Diagnostic script to find orphaned reviews
 * Checks for reviews with broken foreign key relationships
 */

const db = require('./config/database');

async function diagnose() {
  try {
    console.log('\n=== PUSTARA DATABASE DIAGNOSTIC ===\n');

    // Initialize database first
    await db.initializeDatabase();
    console.log('✅ Database initialized\n');

    // 1. Count total reviews
    console.log('1. TOTAL COUNTS');
    const countReviews = await db.executeQuery('SELECT COUNT(*) as count FROM reviews', []);
    const countUsers = await db.executeQuery('SELECT COUNT(*) as count FROM users', []);
    const countBooks = await db.executeQuery('SELECT COUNT(*) as count FROM books', []);
    
    const getCount = (result) => {
      if (result && result.rows && result.rows.length > 0) return result.rows[0].count;
      if (result && result[0]) return result[0].count;
      return 'ERROR';
    };
    
    console.log(`   - Total reviews: ${getCount(countReviews)}`);
    console.log(`   - Total users: ${getCount(countUsers)}`);
    console.log(`   - Total books: ${getCount(countBooks)}\n`);

    // 2. Find reviews with NULL user_id
    console.log('2. REVIEWS WITH NULL user_id');
    const nullUsers = await db.executeQuery(
      'SELECT id, user_id, book_id, created_at FROM reviews WHERE user_id IS NULL LIMIT 5',
      []
    );
    const nullUsersRows = nullUsers?.rows || nullUsers || [];
    console.log(`   - Count: ${nullUsersRows.length}`);
    if (nullUsersRows.length > 0) {
      nullUsersRows.forEach(r => {
        console.log(`     • Review ${r.id}: user_id=${r.user_id}, book_id=${r.book_id}`);
      });
    }
    console.log();

    // 3. Find reviews with NULL book_id
    console.log('3. REVIEWS WITH NULL book_id');
    const nullBooks = await db.executeQuery(
      'SELECT id, user_id, book_id, created_at FROM reviews WHERE book_id IS NULL LIMIT 5',
      []
    );
    const nullBooksRows = nullBooks?.rows || nullBooks || [];
    console.log(`   - Count: ${nullBooksRows.length}`);
    if (nullBooksRows.length > 0) {
      nullBooksRows.forEach(r => {
        console.log(`     • Review ${r.id}: user_id=${r.user_id}, book_id=${r.book_id}`);
      });
    }
    console.log();

    // 4. Find reviews with non-existent user_id (orphaned user reference)
    console.log('4. REVIEWS WITH NON-EXISTENT user_id (Orphaned User Reference)');
    const orphanedUsers = await db.executeQuery(
      `SELECT r.id, r.user_id, r.book_id, r.created_at
       FROM reviews r
       WHERE r.user_id IS NOT NULL
       AND r.user_id NOT IN (SELECT id FROM users)
       LIMIT 10`,
      []
    );
    const orphanedUsersRows = orphanedUsers?.rows || orphanedUsers || [];
    console.log(`   - Count: ${orphanedUsersRows.length}`);
    if (orphanedUsersRows.length > 0) {
      orphanedUsersRows.forEach(r => {
        console.log(`     • Review ${r.id}: user_id=${r.user_id}, book_id=${r.book_id}, created=${r.created_at}`);
      });
    }
    console.log();

    // 5. Find reviews with non-existent book_id (orphaned book reference)
    console.log('5. REVIEWS WITH NON-EXISTENT book_id (Orphaned Book Reference)');
    const orphanedBooks = await db.executeQuery(
      `SELECT r.id, r.user_id, r.book_id, r.created_at
       FROM reviews r
       WHERE r.book_id IS NOT NULL
       AND r.book_id NOT IN (SELECT id FROM books)
       LIMIT 10`,
      []
    );
    const orphanedBooksRows = orphanedBooks?.rows || orphanedBooks || [];
    console.log(`   - Count: ${orphanedBooksRows.length}`);
    if (orphanedBooksRows.length > 0) {
      orphanedBooksRows.forEach(r => {
        console.log(`     • Review ${r.id}: user_id=${r.user_id}, book_id=${r.book_id}, created=${r.created_at}`);
      });
    }
    console.log();

    // 6. Find reviews that successfully join to users AND books
    console.log('6. REVIEWS WITH VALID JOINS (user + book exist)');
    const validReviews = await db.executeQuery(
      `SELECT COUNT(*) as count
       FROM reviews r
       WHERE r.user_id IN (SELECT id FROM users)
       AND r.book_id IN (SELECT id FROM books)`,
      []
    );
    console.log(`   - Count: ${getCount(validReviews)}\n`);

    // 7. Sample review data
    console.log('7. SAMPLE OF FIRST 3 REVIEWS (with JOIN data)');
    const sampleReviews = await db.executeQuery(
      `SELECT r.id, r.user_id, r.book_id, 
              u.id as user_exists, u.display_name,
              b.id as book_exists, b.title
       FROM reviews r
       LEFT JOIN users u ON r.user_id = u.id
       LEFT JOIN books b ON r.book_id = b.id
       LIMIT 3`,
      []
    );
    const sampleRows = sampleReviews?.rows || sampleReviews || [];
    sampleRows.forEach((r, i) => {
      console.log(`   Review ${i + 1}: id=${r.id}`);
      console.log(`     - user_id=${r.user_id} → user_exists=${r.user_exists}, display_name="${r.display_name}"`);
      console.log(`     - book_id=${r.book_id} → book_exists=${r.book_exists}, title="${r.title}"`);
    });
    console.log();

    // 8. Check data types
    console.log('8. DATA TYPE CHECK');
    const usersSample = await db.executeQuery(
      'SELECT id FROM users LIMIT 1',
      []
    );
    const booksSample = await db.executeQuery(
      'SELECT id FROM books LIMIT 1',
      []
    );
    const reviewsSample = await db.executeQuery(
      'SELECT id, user_id, book_id FROM reviews LIMIT 1',
      []
    );
    
    const usersRow = usersSample?.rows?.[0] || usersSample?.[0];
    const booksRow = booksSample?.rows?.[0] || booksSample?.[0];
    const reviewsRow = reviewsSample?.rows?.[0] || reviewsSample?.[0];
    
    if (usersRow) console.log(`   - users.id: ${typeof usersRow.id} = "${usersRow.id}"`);
    if (booksRow) console.log(`   - books.id: ${typeof booksRow.id} = "${booksRow.id}"`);
    if (reviewsRow) {
      console.log(`   - reviews.id: ${typeof reviewsRow.id} = "${reviewsRow.id}"`);
      console.log(`   - reviews.user_id: ${typeof reviewsRow.user_id} = "${reviewsRow.user_id}"`);
      console.log(`   - reviews.book_id: ${typeof reviewsRow.book_id} = "${reviewsRow.book_id}"`);
    }
    console.log();

    console.log('=== END DIAGNOSTIC ===\n');
    process.exit(0);

  } catch (error) {
    console.error('❌ Diagnostic error:', error.message || error);
    process.exit(1);
  }
}

diagnose();
