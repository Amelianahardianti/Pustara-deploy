// Books Controller dengan Azure Blob file handling
const db = require('../config/database');
const azureBlob = require('../providers/azureBlobProvider');
const { v4: uuidv4 } = require('uuid');
const { sendOpsAlert } = require('../services/opsAlertService');
const { insertNotification, getAllNotifiableUsers } = require('../services/notificationService');
const { sendEmail } = require('../services/emailService');
const { Readable } = require('stream');

function toRows(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.rows)) return result.rows;
  if (result && Array.isArray(result.recordset)) return result.recordset;
  return [];
}

function parseGenresCell(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }

  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return [];

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((v) => String(v).trim()).filter(Boolean);
      }
    } catch (_) {
      // ignore JSON parsing errors and continue with delimiter parsing
    }

    if (raw.startsWith('{') && raw.endsWith('}')) {
      return raw
        .slice(1, -1)
        .split(',')
        .map((v) => v.replace(/^"|"$/g, '').trim())
        .filter(Boolean);
    }

    return raw
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  }

  return [];
}

function parseArrayCell(value) {
  return parseGenresCell(value);
}

function parseOptionalNumberCell(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeBookRow(book) {
  if (!book) return book;

  return {
    ...book,
    authors: parseArrayCell(book.authors),
    genres: parseArrayCell(book.genres),
  };
}

function sanitizePagination(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/**
 * Parse query boolean values used by list filters.
 */
function parseBooleanQuery(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return null;
}

function withDownloadUrl(book, req) {
  if (!book || !book.id) return book;

  // Only provide proxy download URL if the book actually has a file in the database
  // This preserves null/undefined file_url so the frontend can show upload buttons
  if (!book.file_url) return book;

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  return {
    ...book,
    file_url: `${baseUrl}/books/${book.id}/file`,
  };
}

function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

async function getQueueCountByBookId(bookId) {
  try {
    const rows = toRows(
      await db.executeQuery('SELECT COUNT(*) AS total FROM queue WHERE book_id = $1', [bookId])
    );
    return Number.parseInt(String(rows[0]?.total || 0), 10) || 0;
  } catch {
    // Queue table may be unavailable in some environments. Keep API stable with zero.
    return 0;
  }
}

async function withQueueCounts(books) {
  const list = Array.isArray(books) ? books : [];
  const counted = await Promise.all(
    list.map(async (book) => {
      const queue = await getQueueCountByBookId(book.id);
      return {
        ...book,
        queue,
      };
    })
  );
  return counted;
}

async function listBooks(req, res, { includeInactive = false, defaultSort = 'created_at', defaultOrder = 'DESC' } = {}) {
  try {
    const {
      page = 1,
      limit = 10,
      genre,
      search,
      available,
      language,
      sort = defaultSort,
      order = defaultOrder,
    } = req.query;
    const pageNum = sanitizePagination(page, 1, 1, 100000);
    const limitNum = sanitizePagination(limit, 10, 1, 100);
    const offset = (pageNum - 1) * limitNum;

    const baseWhere = includeInactive ? 'WHERE 1=1' : 'WHERE is_active = true';
    let query = `SELECT * FROM books ${baseWhere}`;
    const params = [];

    if (search && String(search).trim()) {
      const term = `%${String(search).trim()}%`;
      query += ` AND (title ILIKE $${params.length + 1} OR authors::text ILIKE $${params.length + 1})`;
      params.push(term);
    }

    if (genre) {
      query += ` AND $${params.length + 1} = ANY(genres)`;
      params.push(genre);
    }

    const availableFilter = parseBooleanQuery(available);
    if (availableFilter === true) {
      query += ' AND COALESCE(available, 0) > 0';
    } else if (availableFilter === false) {
      query += ' AND COALESCE(available, 0) <= 0';
    }

    if (language && String(language).trim()) {
      query += ` AND language = $${params.length + 1}`;
      params.push(String(language).trim());
    }

    const validSort = ['created_at', 'avg_rating', 'title', 'year'];
    const validOrder = ['ASC', 'DESC'];
    const sortBy = validSort.includes(sort) ? sort : 'created_at';
    const orderBy = validOrder.includes(order.toUpperCase()) ? order.toUpperCase() : 'DESC';

    query += ` ORDER BY ${sortBy} ${orderBy}`;
    query += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limitNum, offset);

    const result = await db.executeQuery(query, params);
    const rows = toRows(result);

    let countQuery = `SELECT COUNT(*) as total FROM books ${baseWhere}`;
    const countParams = [];

    if (search && String(search).trim()) {
      const term = `%${String(search).trim()}%`;
      countQuery += ` AND (title ILIKE $${countParams.length + 1} OR authors::text ILIKE $${countParams.length + 1})`;
      countParams.push(term);
    }

    if (genre) {
      countQuery += ` AND $${countParams.length + 1} = ANY(genres)`;
      countParams.push(genre);
    }

    if (availableFilter === true) {
      countQuery += ' AND COALESCE(available, 0) > 0';
    } else if (availableFilter === false) {
      countQuery += ' AND COALESCE(available, 0) <= 0';
    }

    if (language && String(language).trim()) {
      countQuery += ` AND language = $${countParams.length + 1}`;
      countParams.push(String(language).trim());
    }

    const countResult = await db.executeQuery(countQuery, countParams);
    const countRows = toRows(countResult);

    const totalItems = Number.parseInt(String(countRows[0]?.total || 0), 10) || 0;
    const totalPages = Math.max(1, Math.ceil(totalItems / limitNum));
    const booksDataWithUrl = rows.map((book) => normalizeBookRow(withDownloadUrl(book, req)));
    const booksData = await withQueueCounts(booksDataWithUrl);

    return res.json({
      success: true,
      data: booksData,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalItems,
        pages: totalPages,
        total_items: totalItems,
        total_pages: totalPages,
      },
    });
  } catch (error) {
    console.error('Error fetching books:', error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
}

// GET /books/recent - Recently added books for homepage and catalog sections
exports.getRecentBooks = async (req, res) => {
  return listBooks(req, res, {
    includeInactive: false,
    defaultSort: 'created_at',
    defaultOrder: 'DESC',
  });
};

/**
 * Validate that the authenticated user has an active, unreturned, non-expired loan.
 */
async function resolveActiveLoanAccess(firebaseUid, bookId) {
  if (!firebaseUid) {
    return { allowed: false, statusCode: 401, message: 'Authentication required' };
  }

  const userRows = toRows(
    await db.executeQuery('SELECT id FROM users WHERE firebase_uid = $1 LIMIT 1', [firebaseUid])
  );
  const userId = userRows[0]?.id;

  if (!userId) {
    return { allowed: false, statusCode: 404, message: 'User not found in Pustara database' };
  }

  const loanRows = toRows(
    await db.executeQuery(
      `SELECT id, COALESCE(due_date, due_at) AS due_date
      FROM loans
      WHERE user_id = $1
        AND book_id = $2
        AND returned_at IS NULL
        AND COALESCE(due_date, due_at) > NOW()
      LIMIT 1`,
      [userId, bookId]
    )
  );

  if (loanRows.length === 0) {
    return {
      allowed: false,
      statusCode: 403,
      message: 'No active loan found for this book or loan already expired',
      userId,
    };
  }

  return {
    allowed: true,
    userId ,
    dueDate: loanRows[0].due_date,
  };
}

// // GET /books/:id/reviews - Get book reviews
exports.getBookReviews = async (req, res) => {
  let phase = 'init';
  try {
    phase = 'parse_request';
    const { id } = req.params;
    const { limit = 100, offset = 0 } = req.query;
    
    // FIX 1: Inline sanitizePagination biar ga "not defined"
    const limitParsed = parseInt(limit, 10);
    const limitNum = !isNaN(limitParsed) ? Math.min(Math.max(limitParsed, 1), 500) : 100;
    
    const offsetParsed = parseInt(offset, 10);
    const offsetNum = !isNaN(offsetParsed) ? Math.max(offsetParsed, 0) : 0;

    console.log('[BookReviews] Request received:', { id, limitQuery: limit, offsetQuery: offset, limitNum, offsetNum });

    // FIX 2: Inline UUID validation biar ga "isUuidLike is not defined"
    const cleanId = String(id || '').trim();
    const isValidUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cleanId);
    
    if (!isValidUuid) {
      console.log('[BookReviews] INVALID UUID:', cleanId);
      return res.status(400).json({
        success: false,
        message: 'Invalid book id format',
        error: { code: 'INVALID_BOOK_ID', id: cleanId },
      });
    }

    // Verify book exists (FIX: Pakai CAST AS TEXT biar 100% jalan)
    phase = 'book_check';
    const bookCheck = await db.executeQuery(
      'SELECT id FROM books WHERE CAST(id AS TEXT) = CAST($1 AS TEXT) AND is_active = true',
      [cleanId]
    );

    const bookRows = toRows(bookCheck);

    if (bookRows.length === 0) {
      console.log('[BookReviews] BOOK NOT FOUND:', cleanId);
      return res.status(404).json({
        success: false,
        message: 'Book not found',
        error: { code: 'BOOK_NOT_FOUND', id: cleanId },
      });
    }
    console.log('[BookReviews] Book found:', cleanId);

    // Get authenticated user's ID
    // FIX 3: Jangan passing `null` murni karena bikin driver DB meledak waktu nge-parse $4. Pakai dummy UUID.
    let viewingUserId = '00000000-0000-0000-0000-000000000000';
    if (req.user?.uid) {
      try {
        phase = 'viewer_lookup';
        const userRows = toRows(
          await db.executeQuery(
            'SELECT id FROM users WHERE firebase_uid = $1 LIMIT 1',
            [req.user.uid]
          )
        );
        if (userRows[0]?.id) viewingUserId = userRows[0].id;
      } catch (_) {
        // If lookup fails, just continue
      }
    }

    // Fetch reviews with user info
    // FIX 4: Ganti syntax ::int dan $4 IS NULL yang rawan crash
    const query = `
      SELECT
        r.id,
        r.user_id,
        r.book_id,
        r.rating,
        r.review_text as text,
        r.review_text as body,
        r.review_text as review_text,
        r.created_at as time,
        COALESCE(u.display_name, u.username) as name,
        u.avatar_url,
        COALESCE(u.display_name, u.username, 'U') as avatar,
        (SELECT CAST(COUNT(*) AS INT) FROM review_likes rl2 WHERE CAST(rl2.review_id AS TEXT) = CAST(r.id AS TEXT)) as likes,
        u.firebase_uid as firebase_uid,
        (CAST(r.user_id AS TEXT) = CAST($4 AS TEXT)) as is_owner,
        CASE
          WHEN CAST($4 AS TEXT) = '00000000-0000-0000-0000-000000000000' THEN FALSE
          ELSE EXISTS (
            SELECT 1
            FROM review_likes rl
            WHERE CAST(rl.review_id AS TEXT) = CAST(r.id AS TEXT)
              AND CAST(rl.user_id AS TEXT) = CAST($4 AS TEXT)
          )
        END as liked
      FROM reviews r
      LEFT JOIN users u ON CAST(r.user_id AS TEXT) = CAST(u.id AS TEXT)
      WHERE CAST(r.book_id AS TEXT) = CAST($1 AS TEXT)
        AND (
          COALESCE(u.public_reviews, true) = true
          OR CAST(r.user_id AS TEXT) = CAST($4 AS TEXT)
        )
      ORDER BY r.created_at DESC
      LIMIT $2 OFFSET $3
    `;

    console.log('[BookReviews] Query:', { bookId: cleanId, limit: limitNum, offset: offsetNum, viewingUserId });
    phase = 'reviews_list_query';
    const result = await db.executeQuery(query, [cleanId, limitNum, offsetNum, viewingUserId]);
    const reviews = toRows(result);
    
    console.log('[BookReviews] Fetched reviews:', reviews.length, 'for book', cleanId);
    if (reviews.length > 0) {
      console.log('[BookReviews] First review sample:', { id: reviews[0]?.id, rating: reviews[0]?.rating, textLen: String(reviews[0]?.text || '').length });
    } else {
      console.log('[BookReviews] NO REVIEWS FOUND for book:', cleanId);
    }

    // Get total count
    phase = 'reviews_count_query';
    const countResult = await db.executeQuery(
      `SELECT CAST(COUNT(*) AS INT) as total FROM reviews r
       LEFT JOIN users u ON CAST(r.user_id AS TEXT) = CAST(u.id AS TEXT)
       WHERE CAST(r.book_id AS TEXT) = CAST($1 AS TEXT)
         AND (COALESCE(u.public_reviews, true) = true OR CAST(r.user_id AS TEXT) = CAST($2 AS TEXT))`,
      [cleanId, viewingUserId]
    );

    const countRows = toRows(countResult);
    const totalReviews = Number.parseInt(String(countRows[0]?.total || 0), 10) || 0;

    const responsePayload = {
      success: true,
      data: reviews,
      pagination: {
        limit: limitNum,
        offset: offsetNum,
        total: totalReviews,
      },
    };

    console.log('[BookReviews] SENDING RESPONSE:', {
      success: true,
      dataCount: reviews.length,
      dataIsArray: Array.isArray(reviews),
      total: totalReviews
    });

    res.json(responsePayload);
  } catch (error) {
    console.error('[BookReviews] EXCEPTION ERROR:', { phase, message: error.message, stack: error.stack });

    res.status(500).json({
      success: false,
      message: error.message,
      error: {
        code: 'BOOK_REVIEWS_QUERY_FAILED',
        phase,
      },
    });
  }
};

// POST /reviews - Create or update a review
exports.createOrUpdateReview = async (req, res) => {
  try {
    const { book_id, rating, body } = req.body;
    const firebase_uid = req.user?.uid;
    const { isNeon } = require('../config/database');

    if (!firebase_uid) {
    return res.status(401).json({
      success: false,
      message: 'User not authenticated',
      });
    }

    const userResult = await db.executeQuery(
      'SELECT id FROM users WHERE firebase_uid = $1',
      [firebase_uid]
    );

    const userRows = toRows(userResult);

    if (userRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    const user_id = userRows[0].id;

    // Validation
    if (!book_id) {
      return res.status(400).json({
        success: false,
        message: 'book_id is required',
      });
    }

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        message: 'rating must be 1-5',
      });
    }

    if (!body || typeof body !== 'string' || body.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'body is required',
      });
    }

    if (!user_id) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated',
      });
    }

    // Check if review exists
    const checkQuery =
      'SELECT id FROM reviews WHERE book_id::text = $1::text AND user_id = $2';

    const checkResult = await db.executeQuery(checkQuery, [
      book_id,
      user_id,
    ]);

    const existingRows = toRows(checkResult);

    let query;
    let values;
    let reviewId;

    // Use appropriate column name based on database type
    const reviewColumn = isNeon ? 'review_text' : 'body';
    const returnColumns = isNeon
      ? 'id, rating, review_text as body, created_at, updated_at'
      : 'id, rating, body, created_at, updated_at';

    if (existingRows.length > 0) {
      // UPDATE existing review
      reviewId = existingRows[0].id;

      query = `
        UPDATE reviews
        SET rating = $1, ${reviewColumn} = $2, updated_at = NOW()
        WHERE id = $3 AND user_id = $4
        RETURNING ${returnColumns}
      `;

      values = [rating, body, reviewId, user_id];
    } else {
      // INSERT new review
      query = `
        INSERT INTO reviews (user_id, book_id, rating, ${reviewColumn})
        VALUES ($1, $2, $3, $4)
        RETURNING ${returnColumns}
      `;

      values = [user_id, book_id, rating, body];
    }

    const result = await db.executeQuery(query, values);
    const rows = toRows(result);

    if (rows.length === 0) {
      return res.status(500).json({
        success: false,
        message: 'Failed to save review',
      });
    }

    const review = rows[0];

    res.json({
      success: true,
      data: {
        id: review.id,
        book_id,
        user_id,
        rating: review.rating,
        body: review.body,
        created_at: review.created_at,
        updated_at: review.updated_at,
      },
    });
  } catch (error) {
    console.error('Error creating/updating review:', error.message);

    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// PUT /reviews/:id - Update a review (only owner)
exports.updateReview = async (req, res) => {
  try {
    const reviewId = req.params.reviewId;
    const { rating, body } = req.body;
    const firebase_uid = req.user?.uid;
    const { isNeon } = require('../config/database');

    if (!firebase_uid) return res.status(401).json({ success: false, message: 'User not authenticated' });
    if (!isUuidLike(reviewId)) return res.status(400).json({ success: false, message: 'Invalid review id' });

    const userResult = await db.executeQuery('SELECT id FROM users WHERE firebase_uid = $1', [firebase_uid]);
    const userRows = toRows(userResult);
    if (!userRows.length) return res.status(404).json({ success: false, message: 'User not found' });
    const user_id = userRows[0].id;

    const reviewRows = toRows(await db.executeQuery('SELECT id, user_id, book_id FROM reviews WHERE id = $1', [reviewId]));
    if (!reviewRows.length) return res.status(404).json({ success: false, message: 'Review not found' });
    if (String(reviewRows[0].user_id) !== String(user_id)) return res.status(403).json({ success: false, message: 'Forbidden' });

    const sets = [];
    const values = [];
    let idx = 1;
    if (typeof rating !== 'undefined' && rating !== null) {
      sets.push(`rating = $${idx++}`);
      values.push(rating);
    }
    if (typeof body !== 'undefined' && body !== null) {
      const reviewColumn = isNeon ? 'review_text' : 'body';
      sets.push(`${reviewColumn} = $${idx++}`);
      values.push(body);
    }

    if (sets.length === 0) return res.status(400).json({ success: false, message: 'Nothing to update' });

    // always update updated_at
    sets.push('updated_at = NOW()');

    values.push(reviewId);
    values.push(user_id);

    const query = `UPDATE reviews SET ${sets.join(', ')} WHERE id = $${values.length - 1} AND user_id = $${values.length} RETURNING id, rating, ${isNeon ? 'review_text as body' : 'body'}, created_at, updated_at, book_id`;

    const result = await db.executeQuery(query, values);
    const rows = toRows(result);
    if (!rows.length) return res.status(500).json({ success: false, message: 'Failed to update review' });

    const review = rows[0];

    // Recalculate book aggregates
    try {
      await db.executeQuery(`UPDATE books SET avg_rating = (SELECT ROUND(AVG(rating)::numeric, 2) FROM reviews WHERE book_id::text = $1::text), rating_count = (SELECT COUNT(*) FROM reviews WHERE book_id::text = $1::text) WHERE id::text = $1::text`, [review.book_id]);
    } catch (_) { /* ignore */ }

    res.json({ success: true, data: { id: review.id, rating: review.rating, body: review.body, created_at: review.created_at, updated_at: review.updated_at } });
  } catch (error) {
    console.error('Error updating review:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE /reviews/:id - Delete a review (only owner)
exports.deleteReview = async (req, res) => {
  try {
    const reviewId = req.params.reviewId;
    const firebase_uid = req.user?.uid;

    if (!firebase_uid) return res.status(401).json({ success: false, message: 'User not authenticated' });
    if (!isUuidLike(reviewId)) return res.status(400).json({ success: false, message: 'Invalid review id' });

    const userResult = await db.executeQuery('SELECT id FROM users WHERE firebase_uid = $1', [firebase_uid]);
    const userRows = toRows(userResult);
    if (!userRows.length) return res.status(404).json({ success: false, message: 'User not found' });
    const user_id = userRows[0].id;

    const reviewRows = toRows(await db.executeQuery('SELECT id, user_id, book_id FROM reviews WHERE id = $1', [reviewId]));
    if (!reviewRows.length) return res.status(404).json({ success: false, message: 'Review not found' });
    if (String(reviewRows[0].user_id) !== String(user_id)) return res.status(403).json({ success: false, message: 'Forbidden' });

    const bookId = reviewRows[0].book_id;

    await db.executeQuery('DELETE FROM reviews WHERE id = $1', [reviewId]);

    try {
      await db.executeQuery(`UPDATE books SET avg_rating = (SELECT ROUND(AVG(rating)::numeric, 2) FROM reviews WHERE book_id::text = $1::text), rating_count = (SELECT COUNT(*) FROM reviews WHERE book_id::text = $1::text) WHERE id::text = $1::text`, [bookId]);
    } catch (_) { /* ignore */ }

    res.json({ success: true, message: 'Review deleted' });
  } catch (error) {
    console.error('Error deleting review:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /books - List all books dengan pagination & filters
exports.getBooks = async (req, res) => {
  return listBooks(req, res, { includeInactive: false });
};

exports.getBooksAdmin = async (req, res) => {
  return listBooks(req, res, { includeInactive: true });
};

// GET /books/:id/access - Validate reader access without streaming file content
exports.getBookReadAccess = async (req, res) => {
  try {
    const { id: bookId } = req.params;
    const access = await resolveActiveLoanAccess(req.user?.uid, bookId);

    if (!access.allowed) {
      return res.status(access.statusCode).json({
        success: false,
        can_read: false,
        message: access.message,
      });
    }

    const sessionRows = toRows(
      await db.executeQuery(
        `SELECT id, current_page, total_pages, progress_percentage, status,
                last_read_at, started_at, finished_at, reading_time_minutes
        FROM reading_sessions
        WHERE user_id = $1 AND book_id = $2
        ORDER BY last_read_at DESC, started_at DESC
        LIMIT 1`,
        [access.userId, bookId]
      )
    );

    const session = sessionRows[0] || null;

    return res.json({
      success: true,
      can_read: true,
      due_date: access.dueDate || null,
      current_page: Number(session?.current_page || 1),
      total_pages: Number(session?.total_pages || 0),
      progress_percentage: Number(session?.progress_percentage || 0),
      reading_session_id: session?.id ? String(session.id) : null,
      session: session
      ? {
          id: String(session.id),
          current_page: Number(session.current_page || 1),
          total_pages: Number(session.total_pages || 0),
          progress_percentage: Number(session.progress_percentage || 0),
          status: session.status,
          last_read_at: session.last_read_at || null,
          started_at: session.started_at || null,
          finished_at: session.finished_at || null,
          reading_time_minutes: Number(session.reading_time_minutes || 0),
        }
      : null,
    });
  } catch (error) {
    console.error('Error validating book read access:', error.message);
    return res.status(500).json({ success: false, can_read: false, message: 'Failed to validate access' });
  }
};

// GET /books/genres - Get unique genre list for browse category
exports.getGenres = async (_req, res) => {
  try {
    const result = await db.executeQuery(
      'SELECT genres FROM books WHERE is_active = true AND genres IS NOT NULL'
    );
    const rows = toRows(result);

    const unique = new Map();
    for (const row of rows) {
      const genres = parseGenresCell(row?.genres);
      for (const genre of genres) {
        const normalized = genre.trim();
        if (!normalized) continue;
        const key = normalized.toLowerCase();
        if (!unique.has(key)) {
          unique.set(key, normalized);
        }
      }
    }

    const data = Array.from(unique.values()).sort((a, b) => a.localeCompare(b, 'id'));

    res.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error('Error fetching genres:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /books/search - Search books
exports.searchBooks = async (req, res) => {
  try {
    const { q, limit = 10 } = req.query;

    if (!q || q.trim().length < 2) {
      return res.status(400).json({ success: false, message: 'Search query too short' });
    }

    const searchQuery = `%${q}%`;
    const query = `
      SELECT id, title, authors, genres, avg_rating, cover_url
      FROM books
      WHERE is_active = true
      AND (title ILIKE $1 OR authors::text ILIKE $1)
      LIMIT $2
    `;

    const result = await db.executeQuery(query, [searchQuery, limit]);
    const rows = toRows(result);

    res.json({
      success: true,
      data: rows
    });
  } catch (error) {
    console.error('Error searching books:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /books/:id - Get single book detail
exports.getBookDetail = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isUuidLike(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid book id format',
        error: {
          code: 'INVALID_BOOK_ID',
          id,
        },
      });
    }

    const query = `
      SELECT
        b.*,
        COALESCE(review_stats.review_avg_rating, 0) AS review_avg_rating,
        COALESCE(review_stats.review_rating_count, 0) AS review_rating_count,
        COALESCE(review_stats.review_count, 0) AS review_count
      FROM books b
      LEFT JOIN (
        SELECT
          book_id,
          COUNT(*) AS review_count,
          SUM(CASE WHEN rating IS NOT NULL THEN 1 ELSE 0 END) AS review_rating_count,
          ROUND(COALESCE(AVG(CAST(rating AS DECIMAL(10, 2))), 0), 2) AS review_avg_rating
        FROM reviews
        GROUP BY book_id
      ) review_stats ON review_stats.book_id = b.id
      WHERE b.id = $1 AND b.is_active = true
      LIMIT 1
    `;
    const result = await db.executeQuery(query, [id]);
    const rows = toRows(result);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Book not found',
        error: {
          code: 'BOOK_NOT_FOUND',
          id,
        },
      });
    }

    const queueCount = await getQueueCountByBookId(id);
    const book = {
      ...withDownloadUrl(normalizedBook, req),
      queue: queueCount,
    };

    res.json({
      success: true,
      data: book
    });
  } catch (error) {
    console.error('Error fetching book detail:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /books/:id/similar - MVP similar books by genre/author
exports.getSimilarBooks = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isUuidLike(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid book id format',
        error: { code: 'INVALID_BOOK_ID', id },
      });
    }

    const seedResult = await db.executeQuery(
      'SELECT id, authors, genres FROM books WHERE id = $1 AND is_active = true',
      [id]
    );
    const seedRows = toRows(seedResult);

    if (seedRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Book not found',
        error: { code: 'BOOK_NOT_FOUND', id },
      });
    }

    const seed = seedRows[0];
    const genres = parseGenresCell(seed.genres);
    const authors = parseGenresCell(seed.authors);

    const conditions = [];
    const params = [id];

    for (const genre of genres.slice(0, 4)) {
      conditions.push(`$${params.length + 1} = ANY(genres)`);
      params.push(genre);
    }

    for (const author of authors.slice(0, 2)) {
      conditions.push(`authors::text ILIKE $${params.length + 1}`);
      params.push(`%${author}%`);
    }

    const whereSimilar = conditions.length > 0 ? `AND (${conditions.join(' OR ')})` : '';
    const similarQuery = `
      SELECT *
      FROM books
      WHERE is_active = true
        AND id <> $1
        ${whereSimilar}
      ORDER BY avg_rating DESC, created_at DESC
      LIMIT 5
    `;

    const similarResult = await db.executeQuery(similarQuery, params);
    const similarRows = toRows(similarResult).map((book) => withDownloadUrl(book, req));

    res.json({
      success: true,
      data: similarRows,
      meta: {
        source_book_id: id,
        total: similarRows.length,
      },
    });
  } catch (error) {
    console.error('Error fetching similar books:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /books/:id/file
exports.downloadBookFile = async (req, res) => {
  try {
    const { id: bookId } = req.params;
    const access = await resolveActiveLoanAccess(req.user?.uid, bookId);
    if (!access.allowed) {
      return res.status(access.statusCode).json({ success: false, message: access.message });
    }
    const userId = access.userId;

    // 3. AMBIL METADATA BUKU
    const bookRows = toRows(await db.executeQuery(
      'SELECT id, title, file_url, file_type FROM books WHERE id = $1 AND is_active = true',
      [bookId]
    ));
    const book = bookRows[0];

    if (!book || !book.file_url) {
      return res.status(404).json({ success: false, message: 'File buku ga ketemu atau emang ga ada.' });
    }

    // 4. RAKIT URL SUPABASE (handle path maupun URL full)
    const supabaseUrl = process.env.SUPABASE_URL || 'https://ojlrymmikhdfqzuycldm.supabase.co';
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!serviceKey) {
      console.error("❌ SUPABASE_SERVICE_ROLE_KEY undefined (backend)!");
    }

    let filePath = book.file_url;
    if (filePath.startsWith('http')) {
      const parts = filePath.split('/pustara-storage/');
      filePath = parts.length > 1 ? parts[1] : filePath;
    }

    const finalUrl = `${supabaseUrl}/storage/v1/object/pustara-storage/${filePath}`;

    console.log(`Secure read access granted for user ${userId} and book ${bookId}`);
    console.log(`📂 Resolved file path: ${filePath}`);
    console.log(`🔗 Final Supabase URL: ${finalUrl}`);

    // 5. Fetch file bytes from Supabase storage.
    const response = await fetch(finalUrl, {
      headers: { 'Authorization': `Bearer ${serviceKey}` }
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      console.error(`❌ Storage Error (${response.status}): ${errorBody}`);
      return res.status(response.status).json({ success: false, message: 'Gagal ambil file dari storage.' });
    }

    // 6. Stream PDF response to browser using Readable.fromWeb.
    res.setHeader('Content-Type', book.file_type || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(book.title)}.pdf"`);

    if (!response.body) {
      return res.status(502).json({ success: false, message: 'Storage response body is empty' });
    }

    Readable.fromWeb(response.body).pipe(res);

  } catch (error) {
    console.error('Error in downloadBookFile:', error.message);
    res.status(500).json({ success: false, message: 'Server error while streaming book file' });
  }
};

// GET /admin/books/:id/file
exports.downloadBookFileAdmin = async (req, res) => {
  try {
    const { id: bookId } = req.params;

    const bookRows = toRows(await db.executeQuery(
      'SELECT id, title, file_url, file_type FROM books WHERE id = $1 AND is_active = true',
      [bookId]
    ));
    const book = bookRows[0];

    if (!book || !book.file_url) {
      return res.status(404).json({ success: false, message: 'File buku ga ketemu atau emang ga ada.' });
    }

    const supabaseUrl = process.env.SUPABASE_URL || 'https://ojlrymmikhdfqzuycldm.supabase.co';
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!serviceKey) {
      console.error('❌ SUPABASE_SERVICE_ROLE_KEY undefined (backend)!');
    }

    let filePath = book.file_url;
    if (filePath.startsWith('http')) {
      const parts = filePath.split('/pustara-storage/');
      filePath = parts.length > 1 ? parts[1] : filePath;
    }

    // Try authenticated endpoint first, fall back to public
    const finalUrl = `${supabaseUrl}/storage/v1/object/pustara-storage/${filePath}`;

    const response = await fetch(finalUrl, {
      headers: { Authorization: `Bearer ${serviceKey}` },
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      console.error(`❌ Admin Storage Error (${response.status}): ${errorBody}`);
      console.error(`📂 file_url from DB: ${book.file_url}`);
      console.error(`🔗 Final URL: ${finalUrl}`);
      return res.status(response.status).json({ success: false, message: 'Gagal ambil file dari storage.' });
    }

    res.setHeader('Content-Type', book.file_type || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(book.title)}.pdf"`);

    if (!response.body) {
      return res.status(502).json({ success: false, message: 'Storage response body is empty' });
    }

    Readable.fromWeb(response.body).pipe(res);
  } catch (error) {
    console.error('Error in downloadBookFileAdmin:', error.message);
    res.status(500).json({ success: false, message: 'Server error while streaming book file' });
  }
};

// POST /books - Admin: Create new book (dengan file upload)
exports.createBook = async (req, res) => {
  try {
    const { title, description, year, pages, language } = req.body;
    let { authors, genres, total_stock, available } = req.body;
    const file = req.files?.bookFile;

    // Validation
    if (!title) {
      return res.status(400).json({ success: false, message: 'Title is required' });
    }

    authors = parseArrayCell(authors);
    if (!Array.isArray(authors) || authors.length === 0) {
      return res.status(400).json({ success: false, message: 'Authors is required (comma-separated or array)' });
    }

    genres = parseArrayCell(genres);
    if (!Array.isArray(genres) || genres.length === 0) {
      return res.status(400).json({ success: false, message: 'Genres is required (comma-separated or array)' });
    }

    const totalStockValue = parseOptionalNumberCell(total_stock) ?? 5;
    const availableValue = parseOptionalNumberCell(available) ?? totalStockValue;

    let fileUrl = null;
    let fileSize = null;
    let fileType = 'application/pdf';

    // Upload file to Azure Blob jika ada
    if (file) {
      if (!['application/pdf', 'application/x-pdf'].includes(file.mimetype)) {
        return res.status(400).json({ success: false, message: 'Only PDF files are allowed' });
      }

      fileType = file.mimetype;
      const fileName = `${uuidv4()}-${Date.now()}.pdf`;

      try {
        fileUrl = await azureBlob.uploadFile(fileName, file.data, fileType);
        fileSize = file.size;
      } catch (uploadError) {
        console.error('Azure upload error:', uploadError.message);
        return res.status(500).json({ success: false, message: 'Failed to upload file to storage' });
      }
    }

    const pool = require('../config/database').getPool();
    const query = `
      INSERT INTO books (title, authors, genres, description, "year", pages, isbn, language, file_url, file_size, file_type, total_stock, available, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, true)
      RETURNING *
    `;

    const result = await pool.query(query, [
      title,
      authors,
      genres,
      description || null,
      year ? parseInt(year) : null,
      pages ? parseInt(pages) : null,
      req.body.isbn?.trim() || null,
      language || 'id',
      fileUrl,
      fileSize,
      fileType,
      totalStockValue,
      availableValue
    ]);

    const createdBook = normalizeBookRow(result.rows[0]);

    // Notify users about newly uploaded books.
    try {
      const users = await getAllNotifiableUsers();
      const titleSafe = String(createdBook?.title || title || 'Buku baru');
      const yearSafe = createdBook?.year ? ` (${createdBook.year})` : '';

      await Promise.all(users.map(async (user) => {
        await insertNotification({
          userId: user.id,
          type: 'system',
          title: 'Buku Baru di Pustara',
          body: `\"${titleSafe}\"${yearSafe} baru saja ditambahkan ke katalog Pustara.`,
          bookId: createdBook?.id || null,
        });

        try {
          await sendEmail({
            to: user.email,
            subject: 'Pustara - Buku Baru Telah Ditambahkan',
            text: [
              `Halo ${user.name || 'Pustara Reader'},`,
              '',
              `Ada buku baru di katalog: \"${titleSafe}\"${yearSafe}.`,
              'Yuk buka Pustara dan cek buku terbaru sekarang.',
            ].join('\n'),
          });
        } catch (mailError) {
          console.warn('New-book email warning:', mailError.message);
        }
      }));
    } catch (notifyError) {
      console.warn('New-book broadcast warning:', notifyError.message);
    }

    res.status(201).json({
      success: true,
      message: 'Book created successfully',
      data: createdBook
    });
  } catch (error) {
    console.error('Error creating book:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

// PUT /books/:id - Admin: Update book
exports.updateBook = async (req, res) => {
  try {
    const { id } = req.params;
    // Ambil file_url dari body (dikirim dari upload-book page)
    const { title, authors: rawAuthors, genres: rawGenres, description, year, pages, isbn,
      is_active, file_url, total_stock, available } = req.body;

    const authors = rawAuthors == null || rawAuthors === '' ? null : parseArrayCell(rawAuthors);
    const genres = rawGenres == null || rawGenres === '' ? null : parseArrayCell(rawGenres);

    const query = `
      UPDATE books
      SET title = COALESCE($1, title),
          authors = COALESCE($2, authors),
          genres = COALESCE($3, genres),
          description = COALESCE($4, description),
          "year" = COALESCE($5, "year"),
          pages = COALESCE($6, pages),
          isbn = COALESCE($7, isbn),
          is_active = COALESCE($8, is_active),
          file_url = COALESCE($9, file_url),
          total_stock = COALESCE($10, total_stock),
          available = COALESCE($11, available),
          updated_at = now()
      WHERE id = $12
      RETURNING *
    `;

    const result = await db.executeQuery(query, [
      title, authors, genres, description, year, pages, isbn?.trim() || null, is_active,
      file_url || null,
      parseOptionalNumberCell(total_stock),
      parseOptionalNumberCell(available),
      id
    ]);

    const rows = toRows(result);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Book not found' });

    res.json({ success: true, message: 'Book updated successfully', data: normalizeBookRow(rows[0]) });
  } catch (error) {
    console.error('Error updating book:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE /books/:id - Admin: Soft delete book
exports.deleteBook = async (req, res) => {
  try {
    const { id } = req.params;

    const query = `
      UPDATE books
      SET is_active = false, updated_at = now()
      WHERE id = $1
      RETURNING *
    `;

    const result = await db.executeQuery(query, [id]);
    const rows = toRows(result);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Book not found' });
    }

    try {
      const deleted = rows[0] || {};
      const actor = req.user?.uid || req.user?.email || 'unknown';
      await sendOpsAlert('Pustara Soft Delete Book', [
        `Actor: ${actor}`,
        `Book ID: ${deleted.id || id}`,
        `Title: ${deleted.title || '-'}`,
        `is_active set to false`,
      ]);
    } catch (alertError) {
      console.warn('Delete alert email failed:', alertError.message);
    }

    res.json({
      success: true,
      message: 'Book deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting book:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE /books/:id/permanent - Admin: Permanently remove book and related rows
exports.deleteBookPermanent = async (req, res) => {
  try {
    const { id } = req.params;

    const query = `
      DELETE FROM books
      WHERE id = $1
      RETURNING *
    `;

    const result = await db.executeQuery(query, [id]);
    const rows = toRows(result);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Book not found' });
    }

    try {
      const deleted = rows[0] || {};
      const actor = req.user?.uid || req.user?.email || 'unknown';
      await sendOpsAlert('Pustara Permanent Delete Book', [
        `Actor: ${actor}`,
        `Book ID: ${deleted.id || id}`,
        `Title: ${deleted.title || '-'}`,
        'Book row deleted from database',
      ]);
    } catch (alertError) {
      console.warn('Permanent delete alert failed:', alertError.message);
    }

    res.json({
      success: true,
      message: 'Book permanently deleted successfully'
    });
  } catch (error) {
    console.error('Error permanently deleting book:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /books/without-file - Admin: Get books without pdf file
exports.getBooksWithoutFile = async (req, res) => {
  try {
    const query = `
      SELECT id, title, authors, genres, description, "year", pages, isbn, language, total_stock, available
      FROM books
      WHERE file_url IS NULL AND is_active = true
      ORDER BY title ASC
    `;
    const result = await db.executeQuery(query, []);
    const rows = toRows(result);
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Error fetching books without file:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /books/top-picks [public]: ambil daftar Pustakrew's Pick
exports.getTopPicks = async (req, res) => {
  try {
    // auto-create tabel if not exists (safe to re-run)
    await db.executeQuery(`
      CREATE TABLE IF NOT EXISTS librarian_picks (
        id          SERIAL PRIMARY KEY,
        book_id     UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        sort_order  INT  NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ DEFAULT now(),
        updated_at  TIMESTAMPTZ DEFAULT now()
      )
    `, []);

    const result = await db.executeQuery(`
      SELECT
        b.id, b.title, b.authors, b.genres, b.cover_url,
        b.avg_rating, b.rating_count, b.year, b.pages,
        b.available, b.total_stock, b.description,
        lp.sort_order
      FROM librarian_picks lp
      JOIN books b ON b.id = lp.book_id AND b.is_active = true
      ORDER BY lp.sort_order ASC
    `, []);

    const rows = toRows(result);
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Error fetching top picks:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

// PUT /admin/books/top-picks [admin]: update daftar Pustakrew's Pick
// Body: { book_ids: ["uuid1", "uuid2", "uuid3"] }
exports.setTopPicks = async (req, res) => {
  try {
    const { book_ids } = req.body;

    if (!Array.isArray(book_ids) || book_ids.length === 0) {
      return res.status(400).json({ success: false, message: 'book_ids harus array dan tidak boleh kosong' });
    }
    if (book_ids.length > 3) {
      return res.status(400).json({ success: false, message: 'Maksimal 3 buku untuk Pustakrew\'s Pick' });
    }

    // Hapus semua picks lama, lalu insert yang baru
    await db.executeQuery('DELETE FROM librarian_picks', []);

    for (let i = 0; i < book_ids.length; i++) {
      await db.executeQuery(
        'INSERT INTO librarian_picks (book_id, sort_order) VALUES ($1, $2)',
        [book_ids[i], i + 1]
      );
    }

    // Return picks terbaru
    const result = await db.executeQuery(`
      SELECT
        b.id, b.title, b.authors, b.genres, b.cover_url,
        b.avg_rating, b.year, lp.sort_order
      FROM librarian_picks lp
      JOIN books b ON b.id = lp.book_id AND b.is_active = true
      ORDER BY lp.sort_order ASC
    `, []);

    res.json({
      success: true,
      message: 'Pustakrew\'s Pick berhasil diperbarui',
      data: toRows(result),
    });
  } catch (error) {
    console.error('Error setting top picks:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};