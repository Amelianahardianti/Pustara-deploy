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

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function calculateBayesianRating(avgRating, voteCount, globalAverage, minVotes = 10) {
  const votes = Math.max(0, toNumber(voteCount));
  const rating = Math.max(0, toNumber(avgRating));
  const baseline = Math.max(0, toNumber(globalAverage));

  if (votes <= 0) return 0;

  return ((votes / (votes + minVotes)) * rating) + ((minVotes / (votes + minVotes)) * baseline);
}

async function getPopularBooks(limit = 40) {
  try {
    const pool = getPool();

    const result = await pool.query(`
      SELECT
        b.id,
        b.title,
        b.authors,
        b.cover_url,
        b.genres,
        b.description,
        b.year,
        b.pages,
        b.created_at,
        b.updated_at,
        COALESCE(b.avg_rating, 0) AS stored_avg_rating,
        COALESCE(b.rating_count, 0) AS stored_rating_count,
        COALESCE(review_stats.review_count, 0) AS review_count,
        COALESCE(review_stats.rating_count, 0) AS review_rating_count,
        COALESCE(review_stats.review_avg_rating, 0) AS review_avg_rating,
        review_stats.last_review_at,
        COALESCE(loan_stats.borrow_count, 0) AS borrow_count,
        loan_stats.last_borrowed_at,
        COALESCE(session_stats.reader_count, 0) AS reader_count,
        COALESCE(session_stats.reading_session_count, 0) AS reading_session_count,
        COALESCE(session_stats.total_reading_minutes, 0) AS total_reading_minutes,
        COALESCE(session_stats.avg_progress, 0) AS avg_progress,
        COALESCE(session_stats.completed_session_count, 0) AS completed_session_count,
        session_stats.last_read_at
      FROM books b
      LEFT JOIN (
        SELECT
          book_id,
          COUNT(*) AS review_count,
          SUM(CASE WHEN rating IS NOT NULL THEN 1 ELSE 0 END) AS rating_count,
          ROUND(COALESCE(AVG(CAST(rating AS DECIMAL(10, 2))), 0), 2) AS review_avg_rating,
          MAX(created_at) AS last_review_at
        FROM reviews
        GROUP BY book_id
      ) review_stats ON review_stats.book_id = b.id
      LEFT JOIN (
        SELECT
          book_id,
          COUNT(*) AS borrow_count,
          MAX(borrowed_at) AS last_borrowed_at
        FROM loans
        GROUP BY book_id
      ) loan_stats ON loan_stats.book_id = b.id
      LEFT JOIN (
        SELECT
          book_id,
          COUNT(DISTINCT user_id) AS reader_count,
          COUNT(*) AS reading_session_count,
          COALESCE(SUM(COALESCE(reading_time_minutes, 0)), 0) AS total_reading_minutes,
          ROUND(COALESCE(AVG(CAST(progress_percentage AS DECIMAL(10, 2))), 0), 2) AS avg_progress,
          SUM(CASE WHEN status = 'finished' THEN 1 ELSE 0 END) AS completed_session_count,
          MAX(last_read_at) AS last_read_at
        FROM reading_sessions
        GROUP BY book_id
      ) session_stats ON session_stats.book_id = b.id
      WHERE b.is_active = true
      ORDER BY b.title ASC
    `, []);

    const rows = result.rows || [];
    const ratedRows = rows.filter((row) => toNumber(row.review_rating_count) > 0);
    const globalAverage = ratedRows.length > 0
      ? ratedRows.reduce((sum, row) => {
          const ratingCount = toNumber(row.review_rating_count);
          const ratingValue = ratingCount > 0 ? toNumber(row.review_avg_rating) : 0;
          return sum + ratingValue;
        }, 0) / ratedRows.length
      : 0;

    const scored = rows
      .map((row) => {
        const reviewCount = toNumber(row.review_count);
        const ratingCount = toNumber(row.review_rating_count);
        const avgRating = ratingCount > 0
          ? toNumber(row.review_avg_rating)
          : 0;
        const qualityScore = calculateBayesianRating(avgRating, ratingCount, globalAverage, 10) / 5;

        const readerCount = toNumber(row.reader_count);
        const borrowCount = toNumber(row.borrow_count);
        const readingSessionCount = toNumber(row.reading_session_count);
        const totalReadingMinutes = toNumber(row.total_reading_minutes);
        const completedSessionCount = toNumber(row.completed_session_count);
        const avgProgress = clamp01(toNumber(row.avg_progress) / 100);
        const engagementScore = (
          (Math.log1p(readerCount) / Math.log1p(50)) * 0.30 +
          (Math.log1p(borrowCount) / Math.log1p(50)) * 0.18 +
          (Math.log1p(readingSessionCount) / Math.log1p(80)) * 0.16 +
          (Math.log1p(totalReadingMinutes) / Math.log1p(5000)) * 0.10 +
          (Math.log1p(completedSessionCount) / Math.log1p(40)) * 0.08 +
          avgProgress * 0.08
        );

        const lastActivity = [
          parseDate(row.last_review_at),
          parseDate(row.last_borrowed_at),
          parseDate(row.last_read_at),
          parseDate(row.updated_at),
          parseDate(row.created_at),
        ].filter(Boolean).sort((left, right) => right - left)[0] || null;

        const freshnessScore = lastActivity
          ? Math.exp(-Math.max(0, (Date.now() - lastActivity.getTime()) / 86400000) / 30)
          : 0;

        const popularityScore = (
          (qualityScore * 0.42) +
          (engagementScore * 0.40) +
          (freshnessScore * 0.18)
        );

        return {
          id: row.id,
          title: row.title,
          authors: row.authors,
          cover_url: row.cover_url,
          genres: row.genres,
          description: row.description,
          year: row.year,
          pages: row.pages,
          avg_rating: avgRating,
          rating_count: ratingCount,
          review_count: reviewCount,
          reader_count: readerCount,
          borrow_count: borrowCount,
          reading_session_count: readingSessionCount,
          total_reading_minutes: totalReadingMinutes,
          completed_session_count: completedSessionCount,
          avg_progress: toNumber(row.avg_progress),
          last_activity_at: lastActivity ? lastActivity.toISOString() : null,
          popularity_score: popularityScore,
        };
      })
      .filter((book) => (
        book.rating_count > 0 ||
        book.review_count > 0 ||
        book.reader_count > 0 ||
        book.borrow_count > 0 ||
        book.reading_session_count > 0 ||
        book.total_reading_minutes > 0
      ))
      .sort((left, right) => {
        if (right.popularity_score !== left.popularity_score) return right.popularity_score - left.popularity_score;
        if (right.reader_count !== left.reader_count) return right.reader_count - left.reader_count;
        if (right.review_count !== left.review_count) return right.review_count - left.review_count;
        return String(left.title || '').localeCompare(String(right.title || ''), 'id');
      })
      .slice(0, limit);

    return scored;
  } catch (error) {
    console.error('Error fetching popular books:', error.message);
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
  getPopularBooks,
  getAdminDashboardAnalytics,
};
