/**
 * Reading Session Controller
 * Handles user reading session operations: start, update progress, finish
 */

const { getPool } = require('../config/database');
const ReadingSessionService = require('../services/readingSessionService');
const UserService = require('../services/userService');

function normalizeReadingPayload(body = {}) {
  return {
    bookId: body.bookId || body.book_id || null,
    currentPage: body.current_page ?? body.currentPage,
    readingTimeMinutesDelta: body.reading_time_minutes_delta ?? body.readingTimeMinutesDelta ?? body.reading_time_minutes ?? body.readingTimeMinutes,
    totalPages: body.totalPages ?? body.total_pages ?? body.total_pages_from_request ?? null,
    status: body.status || 'reading',
  };
}

async function resolveActorUserId(req) {
  if (!req.user?.uid) return null;

  const actor = await UserService.getUserByUid(req.user.uid);
  if (!actor.success || !actor.data?.id) return null;

  return String(actor.data.id);
}

/**
 * Start a new reading session for a book
 * POST /reading/start/:bookId
 */
async function startReadingSession(req, res) {
  try {
    const actorUserId = await resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { bookId } = req.params;
    const { total_pages = 0 } = req.body;

    const pool = getPool();

    // Verify book exists
    const bookCheck = await pool.query(
      'SELECT id, pages FROM books WHERE id = $1 AND is_active = true',
      [bookId]
    );

    if (bookCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Book not found' });
    }

    const bookTotalPages = bookCheck.rows[0].pages || total_pages;

    // Check if session already exists
    const existingSession = await pool.query(
      `SELECT id, status FROM reading_sessions 
       WHERE user_id = $1 AND book_id = $2 AND status != 'finished'`,
      [actorUserId, bookId]
    );

    if (existingSession.rows.length > 0) {
      return res.status(400).json({
        error: 'Active reading session already exists for this book',
        session_id: existingSession.rows[0].id,
        status: existingSession.rows[0].status,
      });
    }

    // Create new reading session
    const initialPage = Number(bookTotalPages) > 0 ? 1 : 0;

    const result = await pool.query(
      `INSERT INTO reading_sessions 
       (user_id, book_id, current_page, total_pages, status, started_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       RETURNING 
         id, user_id, book_id, current_page, total_pages, 
         progress_percentage, status, started_at, reading_time_minutes`,
      [actorUserId, bookId, initialPage, bookTotalPages, 'reading']
    );

    const session = result.rows[0];

    res.status(201).json({
      message: 'Reading session started',
      session: {
        id: session.id,
        book_id: session.book_id,
        status: session.status,
        current_page: session.current_page,
        total_pages: session.total_pages,
        progress_percentage: 0,
        started_at: session.started_at,
        reading_time_minutes: 0,
      },
    });
  } catch (error) {
    console.error('Error starting reading session:', error);
    res.status(500).json({ error: 'Failed to start reading session' });
  }
}

/**
 * Update reading progress
 * PUT /reading/update/:sessionId
 */
async function updateReadingProgress(req, res) {
  try {
    const actorUserId = await resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { sessionId } = req.params;
    const { current_page, reading_time_minutes_delta, reading_time_minutes, status = 'reading' } = req.body;

    console.debug('[ReadingController] updateReadingProgress payload:', {
      actorUserId,
      sessionId,
      current_page,
      reading_time_minutes_delta,
      reading_time_minutes,
      status,
    });

    if (current_page === undefined && reading_time_minutes_delta === undefined && reading_time_minutes === undefined) {
      return res.status(400).json({
        error: 'Must provide current_page and/or reading_time_minutes_delta',
      });
    }

    const pool = getPool();

    // Verify session exists and belongs to user
    const sessionCheck = await pool.query(
      `SELECT id, current_page, total_pages, reading_time_minutes
       FROM reading_sessions 
       WHERE id = $1 AND user_id = $2`,
      [sessionId, actorUserId]
    );

    if (sessionCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Reading session not found' });
    }

    const session = sessionCheck.rows[0];
    const parsedCurrentPage = current_page !== undefined ? Number(current_page) : Number(session.current_page);
    const newPage = Number.isFinite(parsedCurrentPage) ? parsedCurrentPage : Number(session.current_page) || 0;
    const readingTimeDelta = reading_time_minutes_delta !== undefined
      ? Math.max(0, Number(reading_time_minutes_delta) || 0)
      : (reading_time_minutes !== undefined ? Math.max(0, Number(reading_time_minutes) || 0) : 0);
    const newReadingTime = (Number(session.reading_time_minutes) || 0) + readingTimeDelta;

    // Validate page number
    if (newPage < 0 || newPage > session.total_pages) {
      return res.status(400).json({
        error: `Invalid page number. Must be between 0 and ${session.total_pages}`,
      });
    }

    // Calculate progress percentage
    const progress = session.total_pages > 0 
      ? ((newPage / session.total_pages) * 100).toFixed(2)
      : 0;

    const safePage = Math.max(Number(session.current_page) || 0, newPage);

    // Update session
    const result = await pool.query(
      `UPDATE reading_sessions 
       SET current_page = GREATEST(COALESCE(current_page, 0), $1),
           progress_percentage = GREATEST(COALESCE(progress_percentage, 0), $2),
           reading_time_minutes = $3,
           status = $4,
           last_read_at = CURRENT_TIMESTAMP
       WHERE id = $5 AND user_id = $6
       RETURNING 
         id, book_id, current_page, total_pages, 
         progress_percentage, status, last_read_at, reading_time_minutes`,
      [safePage, progress, newReadingTime, status, sessionId, actorUserId]
    );

    const updatedSession = result.rows[0];

    res.json({
      message: 'Reading progress updated',
      session: {
        id: updatedSession.id,
        book_id: updatedSession.book_id,
        current_page: updatedSession.current_page,
        total_pages: updatedSession.total_pages,
        progress_percentage: updatedSession.progress_percentage,
        status: updatedSession.status,
        last_read_at: updatedSession.last_read_at,
        reading_time_minutes: updatedSession.reading_time_minutes,
      },
    });
  } catch (error) {
    console.error('Error updating reading progress:', error);
    res.status(500).json({ error: 'Failed to update reading progress' });
  }
}

/**
 * Finish reading session
 * POST /reading/finish/:sessionId
 */
async function finishReadingSession(req, res) {
  try {
    const actorUserId = await resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { sessionId } = req.params;

    const pool = getPool();

    // Verify session exists and belongs to user
    const sessionCheck = await pool.query(
      `SELECT id, status FROM reading_sessions 
       WHERE id = $1 AND user_id = $2`,
      [sessionId, actorUserId]
    );

    if (sessionCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Reading session not found' });
    }

    if (sessionCheck.rows[0].status === 'finished') {
      return res.status(400).json({ error: 'Reading session already finished' });
    }

    // Mark as finished
    const result = await pool.query(
      `UPDATE reading_sessions 
       SET status = 'finished',
           finished_at = CURRENT_TIMESTAMP,
           current_page = total_pages
       WHERE id = $1 AND user_id = $2
       RETURNING 
         id, book_id, current_page, total_pages, 
         progress_percentage, status, started_at, finished_at, reading_time_minutes`,
      [sessionId, actorUserId]
    );

    const finishedSession = result.rows[0];

    res.json({
      message: 'Reading session finished',
      session: {
        id: finishedSession.id,
        book_id: finishedSession.book_id,
        current_page: finishedSession.current_page,
        total_pages: finishedSession.total_pages,
        progress_percentage: 100,
        status: finishedSession.status,
        started_at: finishedSession.started_at,
        finished_at: finishedSession.finished_at,
        reading_time_minutes: finishedSession.reading_time_minutes,
      },
    });
  } catch (error) {
    console.error('Error finishing reading session:', error);
    res.status(500).json({ error: 'Failed to finish reading session' });
  }
}

/**
 * Update reading progress by bookId
 * POST /reading/update
 */
async function updateReadingProgressByBook(req, res) {
  try {
    const actorUserId = await resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { bookId, currentPage, readingTimeMinutesDelta, readingTimeMinutes, status, totalPages } = normalizeReadingPayload(req.body);

    console.debug('[ReadingController] updateReadingProgressByBook payload:', {
      actorUserId,
      bookId,
      currentPage,
      readingTimeMinutes,
      totalPages,
      status,
    });

    if (!bookId) {
      return res.status(400).json({ error: 'bookId is required' });
    }

    if (status === 'paused' && currentPage === undefined && readingTimeMinutesDelta === undefined && readingTimeMinutes === undefined) {
      const pausedResult = await ReadingSessionService.pauseReading(actorUserId, bookId);
      if (!pausedResult.success) {
        return res.status(400).json({ error: pausedResult.message });
      }

      return res.json({
        message: pausedResult.message,
        data: pausedResult.data,
      });
    }

    const timeDelta = readingTimeMinutesDelta !== undefined ? readingTimeMinutesDelta : readingTimeMinutes;
    const result = await ReadingSessionService.updateReadingProgress(actorUserId, bookId, currentPage, timeDelta, totalPages);

    if (!result.success) {
      return res.status(400).json({ error: result.message });
    }

    return res.json({
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    console.error('Error updating reading progress by book:', error);
    res.status(500).json({ error: 'Failed to update reading progress' });
  }
}

/**
 * Finish reading session by bookId
 * POST /reading/finish
 */
async function finishReadingByBook(req, res) {
  try {
    const actorUserId = await resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { bookId } = normalizeReadingPayload(req.body);

    if (!bookId) {
      return res.status(400).json({ error: 'bookId is required' });
    }

    const result = await ReadingSessionService.finishReading(actorUserId, bookId);

    if (!result.success) {
      return res.status(400).json({ error: result.message });
    }

    return res.json({
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    console.error('Error finishing reading by book:', error);
    res.status(500).json({ error: 'Failed to finish reading session' });
  }
}

/**
 * Pause reading by bookId
 * POST /reading/pause
 */
async function pauseReadingByBook(req, res) {
  try {
    const actorUserId = await resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { bookId } = normalizeReadingPayload(req.body);

    if (!bookId) {
      return res.status(400).json({ error: 'bookId is required' });
    }

    const result = await ReadingSessionService.pauseReading(actorUserId, bookId);

    if (!result.success) {
      return res.status(400).json({ error: result.message });
    }

    return res.json({
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    console.error('Error pausing reading by book:', error);
    res.status(500).json({ error: 'Failed to pause reading session' });
  }
}

/**
 * Get user's current reading sessions
 * GET /reading/sessions
 */
async function getUserSessions(req, res) {
  try {
    const actorUserId = await resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { status = 'reading', limit = 10, offset = 0 } = req.query;

    const pool = getPool();

    let query = `
      SELECT 
        rs.id, rs.book_id, rs.current_page, rs.total_pages,
        rs.progress_percentage, rs.status, rs.started_at, 
        rs.last_read_at, rs.finished_at, rs.reading_time_minutes,
        b.title, b.authors, b.cover_url
      FROM reading_sessions rs
      JOIN books b ON rs.book_id = b.id
      WHERE rs.user_id = $1
    `;

    const params = [actorUserId];

    if (status) {
      query += ` AND rs.status = $${params.length + 1}`;
      params.push(status);
    }

    query += ` ORDER BY rs.last_read_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    res.json({
      sessions: result.rows,
      total: result.rows.length,
    });
  } catch (error) {
    console.error('Error fetching user sessions:', error);
    res.status(500).json({ error: 'Failed to fetch reading sessions' });
  }
}

/**
 * Get specific reading session details
 * GET /reading/:sessionId
 */
async function getSessionDetails(req, res) {
  try {
    const actorUserId = await resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { sessionId } = req.params;

    const pool = getPool();

    const result = await pool.query(
      `SELECT 
        rs.id, rs.book_id, rs.current_page, rs.total_pages,
        rs.progress_percentage, rs.status, rs.started_at, 
        rs.last_read_at, rs.finished_at, rs.reading_time_minutes,
        b.title, b.authors, b.cover_url, b.description
       FROM reading_sessions rs
       JOIN books b ON rs.book_id = b.id
       WHERE rs.id = $1 AND rs.user_id = $2`,
      [sessionId, actorUserId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Reading session not found' });
    }

    res.json({
      session: result.rows[0],
    });
  } catch (error) {
    console.error('Error fetching session details:', error);
    res.status(500).json({ error: 'Failed to fetch session details' });
  }
}

module.exports = {
  startReadingSession,
  updateReadingProgress,
  finishReadingSession,
  updateReadingProgressByBook,
  finishReadingByBook,
  pauseReadingByBook,
  getUserSessions,
  getSessionDetails,
};