#!/usr/bin/env node
const db = require('./config/database');

async function checkReviews() {
  try {
    console.log('📊 [TEST] Checking reviews in database...\n');

    // Get all books
    const booksResult = await db.executeQuery('SELECT id, title FROM books LIMIT 3', []);
    const books = Array.isArray(booksResult.rows) ? booksResult.rows : (booksResult || []);
    console.log('📚 Books found:', books.length);
    
    for (const book of books) {
      console.log(`\n📖 Book: ${book.title} (${book.id})`);
      
      // Check reviews for this book
      const reviewsResult = await db.executeQuery(
        'SELECT id, rating, body, review_text, user_id FROM reviews WHERE book_id = $1 LIMIT 5',
        [book.id]
      );
      const reviews = Array.isArray(reviewsResult.rows) ? reviewsResult.rows : (reviewsResult || []);
      console.log(`  ✓ Reviews: ${reviews.length}`);
      
      if (reviews.length > 0) {
        reviews.forEach((r, idx) => {
          const text = r.body || r.review_text || '(no text)';
          console.log(`    [${idx}] Rating: ${r.rating}, Text: ${String(text).slice(0, 40)}...`);
        });
      }
    }

    console.log('\n📊 Total reviews in DB:');
    const totalResult = await db.executeQuery('SELECT COUNT(*) as cnt FROM reviews', []);
    const totalRows = Array.isArray(totalResult.rows) ? totalResult.rows : (totalResult || []);
    console.log(`  Total: ${totalRows[0]?.cnt || 0}`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

checkReviews();
