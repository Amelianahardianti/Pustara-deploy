const cron   = require('node-cron');
// const axios  = require('axios');
const { executeQuery, isNeon } = require('../config/database');   

const FASTAPI_URL  = process.env.FASTAPI_URL  || 'http://localhost:8001';
const CRON_SECRET  = process.env.CRON_SECRET  || 'pustara-cron-2025';

// ── Simple Logger ─────────────────────────────────────────────────────────────
const log = (level, msg, ...args) => {
  const ts = new Date().toISOString();
  console[level](`[${ts}] [CRON] ${msg}`, ...args);
};

// ══════════════════════════════════════════════════════════════════════════════
// JOB 1 — Daily model rebuild at 03:00 WIB (= UTC 20:00)
// ══════════════════════════════════════════════════════════════════════════════
async function rebuildModels() {
  log('info', '🔄 Triggering model rebuild …');
  try {
    const reindexSecret = process.env.RI_SECRET || CRON_SECRET || 'PUSTARAbrakadaba23';
    const res = await fetch(`${FASTAPI_URL}/reindex`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.HF_TOKEN}`,
      },
      body: JSON.stringify({ secret: reindexSecret }),
      signal: AbortSignal.timeout(5 * 60 * 1000), // Pengganti timeout axios
    });

    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
    const data = await res.json();

    const { catalog_size, model_b, timestamp } = data;
    log('info', '✅ Rebuild done. Catalog: %d, Model B: %s, at %s', catalog_size, model_b, timestamp);
  } catch (err) {
    log('error', '❌ Rebuild failed:', err.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// JOB 2 — Overdue notification check at 08:00 WIB (= UTC 01:00)
// ══════════════════════════════════════════════════════════════════════════════
async function checkOverdueLoans() {
  log('info', '🔍 Checking overdue loans …');
  try {
    const timeFunc = isNeon ? 'NOW()' : 'GETDATE()';
    const intervalQuery = isNeon 
      ? `AND due_at BETWEEN NOW() AND NOW() + INTERVAL '25 hours'`
      : `AND due_at BETWEEN GETDATE() AND DATEADD(hour, 25, GETDATE())`;

    // 1. Update overdue status (Using compatible queries for Neon and Azure)
    const updateQuery = isNeon
      ? `UPDATE loans SET status = 'overdue' WHERE status = 'active' AND due_at < NOW() RETURNING id, user_id, book_id`
      : `UPDATE loans SET status = 'overdue' OUTPUT inserted.id, inserted.user_id, inserted.book_id WHERE status = 'active' AND due_at < GETDATE()`;
    
    const updated = await executeQuery(updateQuery);
    log('info', '  Updated %d loans to overdue.', updated.length);

    // Insert notification (Simple insert without ON CONFLICT for Azure compatibility)
    for (const row of updated) {
      const bookRes = await executeQuery('SELECT title FROM books WHERE id = $1', [row.book_id]);
      const title = bookRes[0]?.title || 'Book';
      
      try {
        await executeQuery(`
          INSERT INTO notifications (user_id, type, title, body, book_id)
          VALUES ($1, 'due', 'Peminjaman Terlambat!', $2, $3)
        `, [row.user_id, `"${title}" sudah melewati tenggat pengembalian. Kembalikan segera.`, row.book_id]);
      } catch (e) { /* Ignore if duplicate */ }
    }

    // 2. Due-in-1-day warning
    const dueTomorrow = await executeQuery(`
      SELECT l.id, l.user_id, l.book_id, b.title
      FROM loans l JOIN books b ON l.book_id = b.id
      WHERE l.status = 'active' ${intervalQuery}
    `);

    for (const row of dueTomorrow) {
      try {
        await executeQuery(`
          INSERT INTO notifications (user_id, type, title, body, book_id)
          VALUES ($1, 'due', 'Tenggat Besok!', $2, $3)
        `, [row.user_id, `"${row.title}" harus dikembalikan besok. Perpanjang sekarang.`, row.book_id]);
      } catch (e) { /* Ignore if duplicate */ }
    }
    
    if (dueTomorrow.length > 0) log('info', '  Sent %d due-tomorrow warnings.', dueTomorrow.length);
  } catch (err) {
    log('error', '❌ Overdue check error:', err.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// JOB 3 — Update avg_rating in books from reviews (every 6 hours)
// ══════════════════════════════════════════════════════════════════════════════
async function syncBookRatings() {
  log('info', '⭐ Syncing book ratings …');
  try {
    const timeFunc = isNeon ? 'NOW()' : 'GETDATE()';
    const castFunc = isNeon ? 'ROUND(AVG(rating)::NUMERIC, 2)' : 'CAST(AVG(rating) AS DECIMAL(10,2))';

    await executeQuery(`
      UPDATE books 
      SET avg_rating = sub.avg_r, rating_count = sub.cnt, updated_at = ${timeFunc}
      FROM (
        SELECT book_id, ${castFunc} AS avg_r, COUNT(*) AS cnt
        FROM reviews
        GROUP BY book_id
      ) sub
      WHERE books.id = sub.book_id
    `);
    log('info', '  Updated ratings successfully.');
  } catch (err) {
    log('error', '❌ Rating sync error:', err.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// JOB 4 — Update available stock from active loans (every hour)
// ══════════════════════════════════════════════════════════════════════════════
async function syncBookStock() {
  try {
    const timeFunc = isNeon ? 'NOW()' : 'GETDATE()';
    const greatestFunc = isNeon 
        ? 'GREATEST(0, total_stock - sub.active_loans)'
        : 'CASE WHEN total_stock - sub.active_loans < 0 THEN 0 ELSE total_stock - sub.active_loans END';

    await executeQuery(`
      UPDATE books 
      SET available = ${greatestFunc}, updated_at = ${timeFunc}
      FROM (
        SELECT book_id, COUNT(*) AS active_loans
        FROM loans
        WHERE status IN ('active','overdue','extended')
        GROUP BY book_id
      ) sub
      WHERE books.id = sub.book_id
    `);

    await executeQuery(`
      UPDATE books
      SET available = total_stock, updated_at = ${timeFunc}
      WHERE id NOT IN (
        SELECT DISTINCT book_id FROM loans
        WHERE status IN ('active','overdue','extended')
      )
      AND available <> total_stock
    `);
  } catch (err) {
    log('error', '❌ Stock sync error:', err.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// START ALL JOBS
// ══════════════════════════════════════════════════════════════════════════════

function startCronJobs() {
  log('info', '🕐 Scheduling cron jobs …');

  cron.schedule('0 20 * * *', rebuildModels, { scheduled: true, timezone: 'UTC' });
  cron.schedule('0 1 * * *', checkOverdueLoans, { scheduled: true, timezone: 'UTC' });
  cron.schedule('0 */6 * * *', syncBookRatings, { scheduled: true, timezone: 'UTC' });
  cron.schedule('5 * * * *', syncBookStock, { scheduled: true, timezone: 'UTC' });

  log('info', '✅ All cron jobs scheduled.');

  // Run once on startup (with a 10s delay to ensure the server is ready)
  setTimeout(() => {
    syncBookStock();
    syncBookRatings();
  }, 10_000);
}

module.exports = { startCronJobs, rebuildModels, checkOverdueLoans, syncBookRatings };