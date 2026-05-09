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
  if (!book || !book.file_url || !book.id) return book;
  
  // If file_url is already an absolute URL (from Supabase Storage, Azure Blob, etc), return as-is
  if (book.file_url.startsWith('http://') || book.file_url.startsWith('https://')) {
    return book;
  }
  
  // Otherwise, construct the download URL for local/relative paths
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  return {
    ...book,
    file_url: `${baseUrl}/books/${book.id}/file`,
  };
}

function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

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

// GET /books/:id/reviews - Get book reviews
exports.getBookReviews = async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 100, offset = 0 } = req.query;
    const limitNum = sanitizePagination(limit, 100, 1, 500);
    const offsetNum = sanitizePagination(offset, 0, 0, 100000);

    if (!isUuidLike(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid book id format',
        error: { code: 'INVALID_BOOK_ID', id },
      });
    }

    // Verify book exists
    const bookCheck = await db.executeQuery(
      'SELECT id FROM books WHERE id = $1 AND is_active = true',
      [id]
    );

    const bookRows = toRows(bookCheck);

    if (bookRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Book not found',
        error: { code: 'BOOK_NOT_FOUND', id },
      });
    }

    // Fetch reviews with user info
    const query = `
      SELECT 
        r.id,
        r.rating,
        r.body as text,
        r.created_at as time,
        u.display_name as name,
        COALESCE(u.display_name, 'U') as avatar
      FROM reviews r
      JOIN users u ON r.user_id = u.id
      WHERE r.book_id = $1
      ORDER BY r.created_at DESC
      LIMIT $2 OFFSET $3
    `;

    const result = await db.executeQuery(query, [id, limitNum, offsetNum]);
    const reviews = toRows(result);

    // Get total count
    const countResult = await db.executeQuery(
      'SELECT COUNT(*) as total FROM reviews WHERE book_id = $1',
      [id]
    );

    const countRows = toRows(countResult);

    const totalReviews =
      Number.parseInt(String(countRows[0]?.total || 0), 10) || 0;

    res.json({
      success: true,
      data: reviews,
      pagination: {
        limit: limitNum,
        offset: offsetNum,
        total: totalReviews,
      },
    });
  } catch (error) {
    console.error('Error fetching book reviews:', error.message);

    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// POST /reviews - Create or update a review
exports.createOrUpdateReview = async (req, res) => {
  try {
    const { book_id, rating, body } = req.body;
    const firebase_uid = req.user?.uid;
    
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
      'SELECT id FROM reviews WHERE book_id = $1 AND user_id = $2';

    const checkResult = await db.executeQuery(checkQuery, [
      book_id,
      user_id,
    ]);

    const existingRows = toRows(checkResult);

    let query;
    let values;
    let reviewId;

    if (existingRows.length > 0) {
      // UPDATE existing review
      reviewId = existingRows[0].id;

      query = `
        UPDATE reviews
        SET rating = $1, body = $2, updated_at = NOW()
        WHERE id = $3 AND user_id = $4
        RETURNING id, rating, body, created_at, updated_at
      `;

      values = [rating, body, reviewId, user_id];
    } else {
      // INSERT new review
      query = `
        INSERT INTO reviews (user_id, book_id, rating, body)
        VALUES ($1, $2, $3, $4)
        RETURNING id, rating, body, created_at, updated_at
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

// GET /books - List all books dengan pagination & filters
exports.getBooks = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      genre,
      search,
      available,
      language,
      sort = 'created_at',
      order = 'DESC',
    } = req.query;
    const pageNum = sanitizePagination(page, 1, 1, 100000);
    const limitNum = sanitizePagination(limit, 10, 1, 100);
    const offset = (pageNum - 1) * limitNum;
    
    let query = 'SELECT * FROM books WHERE is_active = true';
    const params = [];

    if (search && String(search).trim()) {
      const term = `%${String(search).trim()}%`;
      query += ` AND (title ILIKE $${params.length + 1} OR authors::text ILIKE $${params.length + 1})`;
      params.push(term);
    }

    // Filter by genre jika ada
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

    // Sort
    const validSort = ['created_at', 'avg_rating', 'title', 'year'];
    const validOrder = ['ASC', 'DESC'];
    const sortBy = validSort.includes(sort) ? sort : 'created_at';
    const orderBy = validOrder.includes(order.toUpperCase()) ? order.toUpperCase() : 'DESC';
    
    query += ` ORDER BY ${sortBy} ${orderBy}`;
    query += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limitNum, offset);

    const result = await db.executeQuery(query, params);
    const rows = toRows(result);
    
    // Get total count
    let countQuery = 'SELECT COUNT(*) as total FROM books WHERE is_active = true';
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
    const booksData = rows.map((book) => withDownloadUrl(book, req));

    res.json({
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
    res.status(500).json({ success: false, message: error.message });
  }
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

    const query = 'SELECT * FROM books WHERE id = $1 AND is_active = true';
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

    const book = withDownloadUrl(rows[0], req);

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

    const finalUrl = `${supabaseUrl}/storage/v1/object/authenticated/pustara-storage/${filePath}`;

    console.log(`Secure read access granted for user ${userId} and book ${bookId}`);

    // 5. Fetch file bytes from Supabase authenticated bucket.
    const response = await fetch(finalUrl, {
      headers: { 'Authorization': `Bearer ${serviceKey}` }
    });
    
    if (!response.ok) {
      console.error(`❌ Storage Error (${response.status})`);
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

// POST /books - Admin: Create new book (dengan file upload)
exports.createBook = async (req, res) => {
  try {
    const { title, description, year, pages, language } = req.body;
    let { authors, genres } = req.body;
    const file = req.files?.bookFile;

    // Validation
    if (!title) {
      return res.status(400).json({ success: false, message: 'Title is required' });
    }

    // Parse authors - accept string or array
    if (typeof authors === 'string') {
      authors = authors.split(',').map(a => a.trim()).filter(a => a);
    }
    if (!Array.isArray(authors) || authors.length === 0) {
      return res.status(400).json({ success: false, message: 'Authors is required (comma-separated or array)' });
    }

    // Parse genres - accept string or array
    if (typeof genres === 'string') {
      genres = genres.split(',').map(g => g.trim()).filter(g => g);
    }
    if (!Array.isArray(genres) || genres.length === 0) {
      return res.status(400).json({ success: false, message: 'Genres is required (comma-separated or array)' });
    }

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
      INSERT INTO books (title, authors, genres, description, "year", pages, language, file_url, file_size, file_type, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)
      RETURNING *
    `;

    const result = await pool.query(query, [
      title,
      authors,
      genres,
      description || null,
      year ? parseInt(year) : null,
      pages ? parseInt(pages) : null,
      language || 'id',
      fileUrl,
      fileSize,
      fileType
    ]);

    const createdBook = result.rows[0];

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
    const { title, authors, genres, description, year, pages, 
            is_active, file_url, total_stock, available } = req.body;

    const query = `
      UPDATE books 
      SET title = COALESCE($1, title),
          authors = COALESCE($2, authors),
          genres = COALESCE($3, genres),
          description = COALESCE($4, description),
          "year" = COALESCE($5, "year"),
          pages = COALESCE($6, pages),
          is_active = COALESCE($7, is_active),
          file_url = COALESCE($8, file_url),     -- ← ini yang penting!
          total_stock = COALESCE($9, total_stock),
          available = COALESCE($10, available),
          updated_at = now()
      WHERE id = $11
      RETURNING *
    `;

    const result = await db.executeQuery(query, [
      title, authors, genres, description, year, pages, is_active,
      file_url || null,   // ← harus dikirim dari frontend
      total_stock ? Number(total_stock) : null,
      available ? Number(available) : null,
      id
    ]);

    const rows = toRows(result);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Book not found' });

    res.json({ success: true, message: 'Book updated successfully', data: rows[0] });
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
