/**
 * Analytics Service
 * Provides statistics for active users and reading time
 */

const { getPool } = require('../config/database');

/**
 * Get active users statistics
 * @param {number} hours - Look back N hours (default: 24)
 */
async function getActiveUsers(hours = 24) {
  try {
    const pool = getPool();

    const result = await pool.query(`
      SELECT 
        COUNT(DISTINCT user_id) as active_count,
        COUNT(DISTINCT book_id) as books_being_read,
        ROUND(AVG(progress_percentage), 2) as avg_progress
      FROM reading_sessions
      WHERE last_read_at >= NOW() - INTERVAL '${hours} hours'
        AND status IN ('reading', 'paused')
    `);

    return {
      active_users: result.rows[0].active_count || 0,
      books_being_read: result.rows[0].books_being_read || 0,
      avg_progress: result.rows[0].avg_progress || 0,
      time_period_hours: hours,
    };
  } catch (error) {
    console.error('Error fetching active users:', error.message);
    throw error;
  }
}

/**
 * Get reading time statistics
 * @param {string} period - 'today' | 'week' | 'month' | 'all'
 */
async function getReadingTimeStats(period = 'week') {
  try {
    const pool = getPool();

    let interval;
    switch (period.toLowerCase()) {
      case 'today':
        interval = "1 day";
        break;
      case 'week':
        interval = "7 days";
        break;
      case 'month':
        interval = "30 days";
        break;
      default:
        interval = null;
    }

    let query = `
      SELECT 
        SUM(reading_time_minutes) as total_minutes,
        ROUND(AVG(reading_time_minutes), 2) as avg_minutes_per_session,
        COUNT(*) as total_sessions,
        COUNT(DISTINCT user_id) as unique_readers,
        MAX(reading_time_minutes) as max_session_minutes
      FROM reading_sessions
    `;

    if (interval) {
      query += ` WHERE last_read_at >= NOW() - INTERVAL '${interval}'`;
    }

    const result = await pool.query(query);

    return {
      total_minutes_read: result.rows[0].total_minutes || 0,
      avg_minutes_per_session: result.rows[0].avg_minutes_per_session || 0,
      total_sessions: result.rows[0].total_sessions || 0,
      unique_readers: result.rows[0].unique_readers || 0,
      max_session_minutes: result.rows[0].max_session_minutes || 0,
      period: period,
    };
  } catch (error) {
    console.error('Error fetching reading time stats:', error.message);
    throw error;
  }
}

/**
 * Get reading history for a specific user
 * @param {string} userId - User UID
 * @param {number} limit - Number of records
 */
async function getUserReadingHistory(userId, limit = 20) {
  try {
    const pool = getPool();

    const result = await pool.query(`
      SELECT 
        rs.id,
        rs.book_id,
        b.title,
        b.authors,
        rs.current_page,
        rs.total_pages,
        rs.progress_percentage,
        rs.status,
        rs.reading_time_minutes,
        rs.started_at,
        rs.last_read_at,
        rs.finished_at
      FROM reading_sessions rs
      JOIN books b ON rs.book_id = b.id
      WHERE rs.user_id = $1
      ORDER BY rs.last_read_at DESC
      LIMIT $2
    `, [userId, limit]);

    return result.rows;
  } catch (error) {
    console.error('Error fetching user reading history:', error.message);
    throw error;
  }
}

/**
 * Get top books by reading sessions
 * @param {number} limit - Number of top books
 */
async function getTopBooks(limit = 10) {
  try {
    const pool = getPool();

    const result = await pool.query(`
      SELECT 
        b.id,
        b.title,
        b.authors,
        b.cover_url,
        COUNT(DISTINCT rs.user_id) as reader_count,
        SUM(rs.reading_time_minutes) as total_reading_minutes,
        ROUND(AVG(rs.progress_percentage), 2) as avg_progress
      FROM books b
      LEFT JOIN reading_sessions rs ON b.id = rs.book_id
      WHERE b.is_active = true
      GROUP BY b.id, b.title, b.authors, b.cover_url
      ORDER BY reader_count DESC
      LIMIT $1
    `, [limit]);

    return result.rows;
  } catch (error) {
    console.error('Error fetching top books:', error.message);
    throw error;
  }
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function formatDisplayDate(input) {
  if (!input) return null;
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Get admin dashboard analytics data.
 * Designed for FE dashboard-all-things page.
 */
async function getAdminDashboardAnalytics() {
  const pool = getPool();

  const [
    totalsResult,
    topBooksResult,
    categoryResult,
    growthResult,
    activityResult,
  ] = await Promise.all([
    pool.query(`
      SELECT
        (SELECT COUNT(*) FROM books WHERE is_active = true) AS total_books,
        (SELECT COUNT(*) FROM users) AS total_users,
        (SELECT COUNT(*) FROM loans WHERE status IN ('active', 'extended')) AS active_loans,
        (SELECT COUNT(*) FROM users
          WHERE COALESCE(created_at, now()) >= now() - interval '7 days') AS new_users_7d
    `),
    pool.query(`
      SELECT
        b.id,
        b.title,
        COALESCE((b.genres)[1], 'Lainnya') AS primary_genre,
        COUNT(l.id) AS total
      FROM books b
      LEFT JOIN loans l ON l.book_id = b.id
      WHERE b.is_active = true
      GROUP BY b.id, b.title, primary_genre
      ORDER BY total DESC, b.title ASC
      LIMIT 10
    `),
    pool.query(`
      SELECT
        genre,
        COUNT(*)::int AS value
      FROM (
        SELECT unnest(COALESCE(genres, ARRAY['Lainnya'])) AS genre
        FROM books
        WHERE is_active = true
      ) genre_rows
      GROUP BY genre
      ORDER BY value DESC
      LIMIT 6
    `),
    pool.query(`
      SELECT
        to_char(d.day, 'MM-DD') AS day,
        (
          SELECT COUNT(*)
          FROM users u
          WHERE date(COALESCE(u.created_at, now())) <= d.day
        )::int AS users,
        (
          SELECT COUNT(*)
          FROM users u2
          WHERE date(COALESCE(u2.created_at, now())) = d.day
        )::int AS new_users
      FROM (
        SELECT generate_series(current_date - interval '5 days', current_date, interval '1 day')::date AS day
      ) d
      ORDER BY d.day ASC
    `),
    pool.query(`
      SELECT * FROM (
        SELECT
          'Admin Pustara'::text AS actor,
          'Menambahkan buku ' || COALESCE(title, 'Tanpa Judul') AS action,
          'Buku baru masuk katalog'::text AS detail,
          created_at AS event_time
        FROM books
        WHERE created_at IS NOT NULL

        UNION ALL

        SELECT
          'Admin Pustara'::text AS actor,
          'Memperbarui buku ' || COALESCE(title, 'Tanpa Judul') AS action,
          'Metadata buku diperbarui'::text AS detail,
          updated_at AS event_time
        FROM books
        WHERE updated_at IS NOT NULL

        UNION ALL

        SELECT
          COALESCE(u.display_name, u.username, split_part(u.email, '@', 1), 'Pengguna') AS actor,
          'Meminjam buku ' || COALESCE(b.title, 'Tanpa Judul') AS action,
          'Status peminjaman aktif'::text AS detail,
          l.borrowed_at AS event_time
        FROM loans l
        JOIN users u ON u.id = l.user_id
        JOIN books b ON b.id = l.book_id
        WHERE l.borrowed_at IS NOT NULL

        UNION ALL

        SELECT
          COALESCE(u.display_name, u.username, split_part(u.email, '@', 1), 'Pengguna') AS actor,
          'Mengembalikan buku ' || COALESCE(b.title, 'Tanpa Judul') AS action,
          'Buku dikembalikan ke pustaka'::text AS detail,
          l.returned_at AS event_time
        FROM loans l
        JOIN users u ON u.id = l.user_id
        JOIN books b ON b.id = l.book_id
        WHERE l.returned_at IS NOT NULL
      ) x
      WHERE event_time IS NOT NULL
      ORDER BY event_time DESC
      LIMIT 8
    `),
  ]);

  const totals = totalsResult.rows[0] || {};

  return {
    metrics: {
      total_books: toNumber(totals.total_books),
      active_users: toNumber(totals.total_users),
      active_loans: toNumber(totals.active_loans),
      new_users_7d: toNumber(totals.new_users_7d),
    },
    top_books: topBooksResult.rows.map((row) => ({
      id: row.id,
      title: row.title,
      total: toNumber(row.total),
      primary_genre: row.primary_genre || 'Lainnya',
    })),
    category_distribution: categoryResult.rows.map((row) => ({
      label: row.genre || 'Lainnya',
      value: toNumber(row.value),
    })),
    daily_growth: growthResult.rows.map((row) => ({
      day: row.day,
      users: toNumber(row.users),
      newUsers: toNumber(row.new_users),
    })),
    recent_activity: activityResult.rows.map((row) => ({
      actor: row.actor,
      action: row.action,
      detail: row.detail,
      time: formatDisplayDate(row.event_time),
    })),
  };
}

module.exports = {
  getActiveUsers,
  getReadingTimeStats,
  getUserReadingHistory,
  getTopBooks,
  getAdminDashboardAnalytics,
};
