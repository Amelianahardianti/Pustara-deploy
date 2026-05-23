/**
 * Reading Session Service
 * Smart reading progress tracking: halaman, durasi baca, status
 */

const db = require('../config/database');

/**
 * Start atau update reading session
 * Progress tracking dengan 3 cara:
 * 1. Current page (user input halaman berapa sekarang)
 * 2. Calculated percentage (otomatis dari current_page/total_pages)
 * 3. Reading time (berapa lama sudah baca)
 */
exports.updateReadingProgress = async (userId, bookId, currentPage, readingTimeMinutesDelta, totalPagesFromRequest) => {
  try {
    const pool = require('../config/database').getPool();

    // Get book details
    const bookResult = await pool.query(
      'SELECT id, pages FROM books WHERE id = $1',
      [bookId]
    );

    if (bookResult.rows.length === 0) {
      return { success: false, message: 'Buku tidak ditemukan' };
    }

    const bookTotalPages = parseInt(bookResult.rows[0].pages) || 0;
    const totalPages = bookTotalPages > 0 ? bookTotalPages : (parseInt(totalPagesFromRequest) || 0);

    if (totalPages > 0 && bookTotalPages === 0) {
      await pool.query(
        'UPDATE books SET pages = $1 WHERE id = $2 AND (pages IS NULL OR pages = 0)',
        [totalPages, bookId]
      );
    }
    
    const parsedPage = parseInt(currentPage);
    const pageNum = isNaN(parsedPage) ? null : parsedPage;
    const validCurrentPage = totalPages > 0
      ? Math.min(Math.max(pageNum || 1, 1), totalPages)
      : (pageNum || 0);
    const progressPercentage = totalPages > 0
      ? Math.round((validCurrentPage / totalPages) * 100)
      : 0;

    // Check if session exists (only non-finished ones — finished sessions are riwayat and must be preserved)
    const existingResult = await pool.query(
      `SELECT id, current_page, total_pages, progress_percentage, reading_time_minutes FROM reading_sessions 
       WHERE user_id = $1 AND book_id = $2 AND status != 'finished'
       ORDER BY started_at DESC
       LIMIT 1`,
      [userId, bookId]
    );

    const now = new Date();

    console.debug('[ReadingService] updateReadingProgress called with:', {
      userId,
      bookId,
      currentPage: pageNum,
      readingTimeMinutesDelta,
      totalPages,
    });

    if (existingResult.rows.length > 0) {
      // Update existing session
      const session = existingResult.rows[0];
      console.debug('[ReadingService] existing session found:', { id: session.id, reading_time_minutes: session.reading_time_minutes });
      const newReadingTime = (parseInt(session.reading_time_minutes) || 0) + Math.max(0, Number(readingTimeMinutesDelta) || 0);
      const safeCurrentPage = Math.max(parseInt(session.current_page) || 0, validCurrentPage);
      const safeProgressPercentage = totalPages > 0
        ? Math.round((safeCurrentPage / totalPages) * 100)
        : progressPercentage;

      const updateResult = await pool.query(
        `UPDATE reading_sessions
         SET current_page = GREATEST(COALESCE(current_page, 0), $1),
             total_pages = CASE WHEN total_pages = 0 THEN $5 ELSE GREATEST(total_pages, $5) END,
             progress_percentage = GREATEST(COALESCE(progress_percentage, 0), $2),
             last_read_at = $3,
             reading_time_minutes = $4,
             status = CASE
               WHEN $2 >= 100 THEN 'finished'
               ELSE 'reading'
             END
         WHERE user_id = $6 AND book_id = $7 AND status != 'finished'
         RETURNING *`,
        [safeCurrentPage, safeProgressPercentage, now, newReadingTime, totalPages, userId, bookId]
      );

      console.debug('[ReadingService] updated session result:', updateResult.rows[0]);

      return {
        success: true,
        data: updateResult.rows[0],
        message: `Progress update: ${safeCurrentPage}/${totalPages} halaman (${safeProgressPercentage}%)`,
      };
    } else {
      // Create new session
      const createResult = await pool.query(
        `INSERT INTO reading_sessions 
         (user_id, book_id, current_page, total_pages, progress_percentage, started_at, last_read_at, reading_time_minutes, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'reading')
         RETURNING *`,
        [userId, bookId, validCurrentPage, totalPages, progressPercentage, now, now, Math.max(0, Number(readingTimeMinutesDelta) || 0)]
      );

      console.debug('[ReadingService] created session result:', createResult.rows[0]);

      return {
        success: true,
        data: createResult.rows[0],
        message: `Mulai membaca: ${validCurrentPage}/${totalPages} halaman`,
      };
    }
  } catch (error) {
    console.error('Error updating reading progress:', error.message);
    return { success: false, message: error.message };
  }
};

/**
 * Mark reading as finished
 */
exports.finishReading = async (userId, bookId) => {
  try {
    const pool = require('../config/database').getPool();

    const finishedAt = new Date();

    const result = await pool.query(
      `UPDATE reading_sessions
       SET status = 'finished', finished_at = $1, progress_percentage = 100
       WHERE user_id = $2 AND book_id = $3 AND status != 'finished'
       RETURNING *`,
      [finishedAt, userId, bookId]
    );

    if (result.rows.length === 0) {
      return { success: false, message: 'Reading session tidak ditemukan' };
    }

    return {
      success: true,
      data: result.rows[0],
      message: 'Selamat! Buku selesai dibaca 🎉',
    };
  } catch (error) {
    console.error('Error finishing reading:', error.message);
    return { success: false, message: error.message };
  }
};

/**
 * Pause reading session
 */
exports.pauseReading = async (userId, bookId) => {
  try {
    const pool = require('../config/database').getPool();

    const result = await pool.query(
      `UPDATE reading_sessions
       SET status = 'paused'
       WHERE user_id = $1 AND book_id = $2 AND status != 'finished'
       RETURNING *`,
      [userId, bookId]
    );

    if (result.rows.length === 0) {
      return { success: false, message: 'Reading session tidak ditemukan' };
    }

    return {
      success: true,
      data: result.rows[0],
      message: 'Pembacaan dijeda. Lanjutkan kapan saja!',
    };
  } catch (error) {
    console.error('Error pausing reading:', error.message);
    return { success: false, message: error.message };
  }
};

/**
 * Resume reading from pause
 */
exports.resumeReading = async (userId, bookId) => {
  try {
    const pool = require('../config/database').getPool();

    const now = new Date();

    const result = await pool.query(
      `UPDATE reading_sessions
       SET status = 'reading', last_read_at = $1
       WHERE user_id = $2 AND book_id = $3 AND status != 'finished'
       RETURNING *`,
      [now, userId, bookId]
    );

    if (result.rows.length === 0) {
      return { success: false, message: 'Reading session tidak ditemukan' };
    }

    return {
      success: true,
      data: result.rows[0],
      message: 'Mari lanjut membaca!',
    };
  } catch (error) {
    console.error('Error resuming reading:', error.message);
    return { success: false, message: error.message };
  }
};

/**
 * Get reading statistics untuk user
 */
exports.getReadingStats = async (userId) => {
  try {
    const pool = require('../config/database').getPool();

    const result = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'reading') as currently_reading,
         COUNT(*) FILTER (WHERE status = 'finished') as books_finished,
         COUNT(*) FILTER (WHERE status = 'paused') as books_paused,
         ROUND(AVG(NULLIF(progress_percentage, 0))::numeric, 1) as avg_progress,
         SUM(reading_time_minutes) as total_reading_minutes,
         MAX(last_read_at) as last_read_at
       FROM reading_sessions
       WHERE user_id = $1`,
      [userId]
    );

    const stats = result.rows[0];

    return {
      currentlyReading: parseInt(stats.currently_reading) || 0,
      booksFinished: parseInt(stats.books_finished) || 0,
      booksPaused: parseInt(stats.books_paused) || 0,
      avgProgress: parseFloat(stats.avg_progress) || 0,
      totalReadingHours: Math.round((parseInt(stats.total_reading_minutes) || 0) / 60),
      lastReadAt: stats.last_read_at,
    };
  } catch (error) {
    console.error('Error getting reading stats:', error.message);
    return null;
  }
};

/**
 * Calculate reading habit insights
 * Saran untuk user berdasarkan pattern membaca
 */
exports.getReadingInsights = async (userId) => {
  try {
    const pool = require('../config/database').getPool();

    // Get top 3 genres user paling sering baca
    const genresResult = await pool.query(
      `SELECT 
         jsonb_array_elements(b.genres)::text as genre,
         COUNT(*) as count
       FROM reading_sessions rs
       JOIN books b ON rs.book_id = b.id
       WHERE rs.user_id = $1 AND rs.status = 'finished'
       GROUP BY genre
       ORDER BY count DESC
       LIMIT 3`,
      [userId]
    );

    // Calculate average reading streak (berapa lama baca per hari)
    const streakResult = await pool.query(
      `SELECT
         AVG(reading_time_minutes) as avg_daily_reading,
         MAX(reading_time_minutes) as max_daily_reading
       FROM reading_sessions
       WHERE user_id = $1 AND status != 'paused'`,
      [userId]
    );

    const topGenres = genresResult.rows.map(r => r.genre);
    const avgDailyReading = parseInt(streakResult.rows[0]?.avg_daily_reading) || 0;

    return {
      favoriteGenres: topGenres,
      avgDailyReadingMinutes: avgDailyReading,
      suggestion: generateReadingSuggestion(avgDailyReading, topGenres),
    };
  } catch (error) {
    console.error('Error getting reading insights:', error.message);
    return null;
  }
};

/**
 * Generate personalized reading suggestion
 */
function generateReadingSuggestion(avgDailyMinutes, favoriteGenres) {
  let suggestion = '📚 ';

  if (avgDailyMinutes === 0) {
    suggestion += 'Mulai membaca sekarang! Bahkan 10 menit sehari cukup untuk terbentuk kebiasaan baik.';
  } else if (avgDailyMinutes < 15) {
    suggestion += 'Hebat mulai baca! Coba naikkan target jadi 20 menit/hari untuk hasil maksimal.';
  } else if (avgDailyMinutes < 30) {
    suggestion += 'Konsisten! Kamu pembaca yang bagus. Coba eksplorasi genre baru selain ' + (favoriteGenres[0] || 'favorit') + '.';
  } else {
    suggestion += 'Wow, pembaca sejati! Kamu sudah membentuk habit membaca yang sempurna.';
  }

  return suggestion;
}
