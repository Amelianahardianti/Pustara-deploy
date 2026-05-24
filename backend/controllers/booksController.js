// Books Controller dengan file handling
const db = require('../config/database');
// PRODUCTION: Uncomment Azure Blob
// const azureBlob = require('../providers/azureBlobProvider');
// DEVELOPMENT: Using local filesystem storage
const storage = require('../providers/localStorageProvider');
const { v4: uuidv4 } = require('uuid');

const SUPABASE_PROJECT_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_BUCKET = 'pustara-storage';

function getBackendBaseUrl(req) {
  const forwardedProto = Array.isArray(req.headers['x-forwarded-proto'])
    ? req.headers['x-forwarded-proto'][0]
    : req.headers['x-forwarded-proto'];
  const forwardedHost = Array.isArray(req.headers['x-forwarded-host'])
    ? req.headers['x-forwarded-host'][0]
    : req.headers['x-forwarded-host'];

  const protocol = String(forwardedProto || req.protocol || 'http').split(',')[0].trim() || 'http';
  const host = String(forwardedHost || req.get('host') || '').split(',')[0].trim();

  if (!host) {
    return `http://localhost:${process.env.PORT || 3000}`;
  }

  return `${protocol}://${host}`;
}

function getBookFileEndpoint(req, bookId) {
  return `${getBackendBaseUrl(req)}/books/${bookId}/file`;
}

function getSupabasePublicUrl(fileUrl) {
  if (!fileUrl) return null;

  if (/^https?:\/\//i.test(fileUrl)) {
    if (fileUrl.includes('/storage/v1/object/public/')) {
      return fileUrl;
    }
    return null;
  }

  if (!SUPABASE_PROJECT_URL) {
    return null;
  }

  const normalizedPath = String(fileUrl)
    .replace(/^\/+/, '')
    .replace(/^storage\/v1\/object\/public\//, '');

  if (!normalizedPath) return null;

  if (normalizedPath.startsWith(`${SUPABASE_BUCKET}/`)) {
    return `${SUPABASE_PROJECT_URL}/storage/v1/object/public/${normalizedPath}`;
  }

  return `${SUPABASE_PROJECT_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${normalizedPath}`;
}

/**
 * Generate placeholder cover image (base64 SVG)
 * Works offline, no external dependencies
 */
function getPlaceholderCover(title) {
  if (!title) title = 'Book';
  
  // Truncate title for display
  const displayTitle = title.substring(0, 20);
  
  // Generate color based on title hash
  const colors = ['#667eea', '#764ba2', '#f093fb', '#4facfe', '#43e97b', '#fa709a', '#fee140', '#30cfd0'];
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = ((hash << 5) - hash) + title.charCodeAt(i);
    hash = hash & hash;
  }
  const color = colors[Math.abs(hash) % colors.length];
  
  // Create SVG placeholder
  const svg = `
    <svg width="200" height="300" xmlns="http://www.w3.org/2000/svg">
      <rect width="200" height="300" fill="${color}"/>
      <text x="100" y="150" font-size="18" fill="white" text-anchor="middle" font-weight="bold" font-family="Arial">
        <tspan x="100" dy="0">${displayTitle}</tspan>
      </text>
      <text x="100" y="260" font-size="12" fill="rgba(255,255,255,0.7)" text-anchor="middle" font-family="Arial">
        Pustara
      </text>
    </svg>
  `;
  
  // Convert to base64
  const base64 = Buffer.from(svg).toString('base64');
  return `data:image/svg+xml;base64,${base64}`;
}

// GET /books - List all books dengan pagination & filters
exports.getBooks = async (req, res) => {
  try {
    const { page = 1, limit = 10, genre, sort = 'created_at', order = 'DESC' } = req.query;
    const offset = (page - 1) * limit;
    
    let query = 'SELECT * FROM books WHERE is_active = true';
    const params = [];

    // Filter by genre jika ada
    if (genre) {
      query += ` AND $${params.length + 1} = ANY(genres)`;
      params.push(genre);
    }

    // Sort
    const validSort = ['created_at', 'avg_rating', 'title', 'year'];
    const validOrder = ['ASC', 'DESC'];
    const sortBy = validSort.includes(sort) ? sort : 'created_at';
    const orderBy = validOrder.includes(order.toUpperCase()) ? order.toUpperCase() : 'DESC';
    
    query += ` ORDER BY ${sortBy} ${orderBy}`;
    query += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await db.executeQuery(query, params);
    
    // Get total count
    let countQuery = 'SELECT COUNT(*) as total FROM books WHERE is_active = true';
    const countParams = [];
    if (genre) {
      countQuery += ` AND $1 = ANY(genres)`;
      countParams.push(genre);
    }
    const countResult = await db.executeQuery(countQuery, countParams);

    // Transform file_url to use backend endpoint instead of direct blob URL
    const booksData = result.rows.map(book => ({
      ...book,
      cover_url: book.cover_id 
        ? `https://covers.openlibrary.org/b/id/${book.cover_id}-M.jpg`
        : book.isbn
          ? `https://covers.openlibrary.org/b/isbn/${book.isbn.replace(/[-\s]/g, '')}-M.jpg`
          : getPlaceholderCover(book.title),
      file_url: book.file_url && book.id
        ? getBookFileEndpoint(req, book.id)
        : null
    }));

    res.json({
      success: true,
      data: booksData,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].total),
        pages: Math.ceil(parseInt(countResult.rows[0].total) / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching books:', error.message);
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
      SELECT id, title, authors, genres, avg_rating, cover_id, isbn, year, pages, description, file_url
      FROM books 
      WHERE is_active = true 
      AND (title ILIKE $1 OR authors::text ILIKE $1)
      ORDER BY avg_rating DESC, created_at DESC
      LIMIT $2
    `;

    const result = await db.executeQuery(query, [searchQuery, limit]);

    // Build cover URL from cover_id or ISBN
    const booksData = result.rows.map(book => ({
      id: book.id,
      title: book.title,
      authors: book.authors,
      genres: book.genres,
      avg_rating: parseFloat(book.avg_rating),
      cover_id: book.cover_id,
      cover_url: book.cover_id 
        ? `https://covers.openlibrary.org/b/id/${book.cover_id}-M.jpg`
        : book.isbn
          ? `https://covers.openlibrary.org/b/isbn/${book.isbn.replace(/[-\s]/g, '')}-M.jpg`
          : getPlaceholderCover(book.title),
      isbn: book.isbn,
      year: book.year,
      pages: book.pages,
      description: book.description,
      file_url: book.file_url ? getBookFileEndpoint(req, book.id) : null
    }));

    res.json({
      success: true,
      data: booksData,
      count: booksData.length
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

    const query = 'SELECT * FROM books WHERE id = $1 AND is_active = true';
    const result = await db.executeQuery(query, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Book not found' });
    }

    const book = result.rows[0];
    // Keep actual file URL for PDF viewer
    // file_url is already set to http://localhost:3000/uploads/{filename}
    
    console.log('[DEBUG] getBookDetail returning:', {
      id: book.id,
      title: book.title,
      avg_rating: book.avg_rating,
      rating_count: book.rating_count,
    });

    res.json({
      success: true,
      data: {
        ...book,
        file_url: book.file_url ? getBookFileEndpoint(req, book.id) : null,
      }
    });
  } catch (error) {
    console.error('Error fetching book detail:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

// DEBUG ENDPOINT: Get raw database values for a book
exports.getBookDebug = async (req, res) => {
  try {
    const { id } = req.params;
    const pool = require('../config/database').getPool();

    // Get book with stats
    const bookQuery = 'SELECT id, title, avg_rating, rating_count FROM books WHERE id = $1';
    const bookResult = await pool.query(bookQuery, [id]);

    if (bookResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Book not found' });
    }

    // Get reviews count and avg from reviews table directly
    const statsQuery = `
      SELECT 
        COUNT(*) as review_count,
        ROUND(AVG(rating)::numeric, 2) as avg_from_reviews
      FROM reviews
      WHERE book_id = $1
    `;
    const statsResult = await pool.query(statsQuery, [id]);

    const book = bookResult.rows[0];
    const stats = statsResult.rows[0];

    console.log('[DEBUG] Book stats comparison:', {
      from_books_table: { avg_rating: book.avg_rating, rating_count: book.rating_count },
      from_reviews_table: { avg: stats.avg_from_reviews, count: stats.review_count }
    });

    res.json({
      success: true,
      data: {
        book_stats: {
          id: book.id,
          title: book.title,
          avg_rating: parseFloat(book.avg_rating) || 0,
          rating_count: parseInt(book.rating_count) || 0,
        },
        calculated_from_reviews: {
          avg: parseFloat(stats.avg_from_reviews) || 0,
          count: parseInt(stats.review_count) || 0,
        },
        match: book.avg_rating == stats.avg_from_reviews && book.rating_count == stats.review_count
      }
    });
  } catch (error) {
    console.error('Error getting book debug:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /books/:id/file - Stream PDF file for reader (starts reading session)
exports.downloadBookFile = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.uid; // From auth middleware

    // Get book from database
    const query = 'SELECT id, title, pages, file_url, file_type FROM books WHERE id = $1';
    const result = await db.executeQuery(query, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Book not found' });
    }

    const book = result.rows[0];

    if (!book.file_url) {
      return res.status(404).json({ success: false, message: 'Book file not available' });
    }

    const supabasePublicUrl = getSupabasePublicUrl(book.file_url);
    if (supabasePublicUrl) {
      return res.redirect(302, supabasePublicUrl);
    }

    // If user authenticated, log reading session (fire and forget)
    if (userId) {
      setImmediate(async () => {
        try {
          const { getPool } = require('../config/database');
          const pool = getPool();
          
          // Check if user has active session for this book
          const sessionCheck = await pool.query(
            'SELECT id FROM reading_sessions WHERE user_id = $1 AND book_id = $2 AND status = $3',
            [userId, id, 'reading']
          );

          if (sessionCheck.rows.length === 0) {
            // Create new reading session
            await pool.query(
              `INSERT INTO reading_sessions (user_id, book_id, total_pages, status, started_at)
               VALUES ($1, $2, $3, $4, NOW())`,
              [userId, id, book.pages || 0, 'reading']
            );
            console.log(`✅ Started reading session for user ${userId} on book ${book.title}`);
          }
        } catch (sessionError) {
          console.warn('⚠️  Could not create reading session:', sessionError.message);
        }
      });
    }

    // Extract filename from URL (e.g., "http://localhost:3000/uploads/uuid-time.pdf" -> "uuid-time.pdf")
    const fileName = book.file_url.split('/').pop();

    if (!fileName) {
      return res.status(400).json({ success: false, message: 'Invalid file URL' });
    }

    // Stream file from local storage
    try {
      const stream = await storage.downloadFile(fileName);
      res.setHeader('Content-Type', book.file_type || 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${book.title}.pdf"`);
      stream.pipe(res);
    } catch (streamError) {
      console.error('Error streaming file:', streamError.message);
      return res.status(500).json({ success: false, message: 'Could not stream file' });
    }
  } catch (error) {
    console.error('Error downloading book file:', error.message);
    res.status(500).json({ success: false, message: error.message });
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
    let fileType = 'application/pdf';

    // Upload file to local storage
    if (file) {
      if (!['application/pdf', 'application/x-pdf'].includes(file.mimetype)) {
        return res.status(400).json({ success: false, message: 'Only PDF files are allowed' });
      }

      fileType = file.mimetype;
      const fileName = `${uuidv4()}-${Date.now()}.pdf`;
      
      try {
        // Read file data (handle both temp file and in-memory data)
        let fileBuffer;
        if (file.tempFilePath) {
          // If using temp files, read from disk
          const fs = require('fs');
          fileBuffer = fs.readFileSync(file.tempFilePath);
        } else {
          // Fallback to in-memory data
          fileBuffer = file.data;
        }

        // Check file size
        if (!fileBuffer || fileBuffer.length === 0) {
          return res.status(400).json({ success: false, message: 'PDF file is empty (0 bytes)' });
        }

        // PRODUCTION: Upload to Azure Blob
        // fileUrl = await azureBlob.uploadFile(fileName, file.data, fileType);
        // DEVELOPMENT: Upload to local storage
        fileUrl = await storage.uploadFile(fileName, fileBuffer, fileType);
      } catch (uploadError) {
        console.error('Storage upload error:', uploadError.message);
        return res.status(500).json({ success: false, message: 'Failed to upload file to storage' });
      }
    }

    const pool = require('../config/database').getPool();
    const query = `
      INSERT INTO books (title, authors, genres, description, "year", pages, language, file_url, file_type, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
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
      fileType
    ]);

    res.status(201).json({
      success: true,
      message: 'Book created successfully',
      data: result.rows[0]
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
    const { title, authors, genres, description, year, pages, is_active } = req.body;

    const query = `
      UPDATE books 
      SET title = COALESCE($1, title),
          authors = COALESCE($2, authors),
          genres = COALESCE($3, genres),
          description = COALESCE($4, description),
          "year" = COALESCE($5, "year"),
          pages = COALESCE($6, pages),
          is_active = COALESCE($7, is_active),
          updated_at = now()
      WHERE id = $8
      RETURNING *
    `;

    const result = await db.executeQuery(query, [
      title, authors, genres, description, year, pages, is_active, id
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Book not found' });
    }

    res.json({
      success: true,
      message: 'Book updated successfully',
      data: result.rows[0]
    });
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

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Book not found' });
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

// GET /books/trending - Get trending books for homepage
exports.getTrendingBooks = async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    const limitNum = Math.min(parseInt(limit) || 10, 50); // Cap at 50

    // Check if database is initialized
    if (!db || typeof db.executeQuery !== 'function') {
      console.error('❌ Database not initialized for getTrendingBooks');
      return res.status(503).json({ 
        success: false, 
        message: 'Database service unavailable. Please restart the server.' 
      });
    }

    // Simple query: rank by avg_rating and recency
    // TODO: Add reading_sessions table to schema when ready for activity-based trending
    const query = `
      SELECT 
        b.id,
        b.title,
        b.authors,
        b.genres,
        b.description,
        b.year,
        b.pages,
        b.isbn,
        b.cover_id,
        b.avg_rating,
        b.rating_count,
        b.file_url,
        b.created_at,
        ROUND((COALESCE(b.avg_rating, 0) * 10)::numeric)::int as trending_score
      FROM books b
      WHERE b.is_active = true
      ORDER BY b.avg_rating DESC, b.created_at DESC
      LIMIT $1
    `;

    const result = await db.executeQuery(query, [limitNum]);

    // Build cover URL from cover_id or ISBN
    const booksData = result.rows.map(book => ({
      id: book.id,
      title: book.title,
      authors: book.authors,
      genres: book.genres,
      description: book.description,
      year: book.year,
      pages: book.pages,
      isbn: book.isbn,
      cover_id: book.cover_id,
      cover_url: book.cover_id 
        ? `https://covers.openlibrary.org/b/id/${book.cover_id}-M.jpg`
        : book.isbn
          ? `https://covers.openlibrary.org/b/isbn/${book.isbn.replace(/[-\s]/g, '')}-M.jpg`
          : getPlaceholderCover(book.title),
      avg_rating: parseFloat(book.avg_rating) || 0,
      rating_count: parseInt(book.rating_count) || 0,
      file_url: book.file_url ? getBookFileEndpoint(req, book.id) : null,
      trending_score: parseInt(book.trending_score) || 0
    }));

    res.json({
      success: true,
      data: booksData,
      count: booksData.length
    });
  } catch (error) {
    console.error('Error fetching trending books:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /genres - List available genres
exports.getGenres = async (req, res) => {
  const genres = [
    'Fiksi',
    'Sastra',
    'Sejarah',
    'Sains',
    'Biografi',
    'Romansa',
    'Misteri',
    'Teknologi',
    'Pendidikan',
    'Filsafat',
    'Psikologi',
    'Seni',
    'Agama',
    'Ekonomi',
    'Politik',
    'Olahraga'
  ];
  res.json({ success: true, data: genres });
};

// DEVELOPMENT ONLY: GET /upload-book - Simple HTML upload form
exports.getUploadForm = async (req, res) => {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title> Upload Buku - Pustara</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    
    .container {
      background: white;
      border-radius: 10px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      max-width: 500px;
      width: 100%;
      padding: 40px;
    }
    
    h1 {
      color: #333;
      margin-bottom: 10px;
      font-size: 28px;
    }
    
    .subtitle {
      color: #666;
      margin-bottom: 30px;
      font-size: 14px;
    }
    
    .form-group {
      margin-bottom: 20px;
    }
    
    label {
      display: block;
      color: #333;
      font-weight: 600;
      margin-bottom: 8px;
      font-size: 14px;
    }
    
    input[type="text"],
    textarea {
      width: 100%;
      padding: 12px;
      border: 2px solid #e0e0e0;
      border-radius: 6px;
      font-size: 14px;
      font-family: inherit;
      transition: border-color 0.3s;
    }
    
    input[type="text"]:focus,
    textarea:focus {
      outline: none;
      border-color: #667eea;
    }
    
    .file-upload {
      position: relative;
      border: 2px dashed #667eea;
      border-radius: 6px;
      padding: 30px;
      text-align: center;
      cursor: pointer;
      transition: all 0.3s;
      background: #f8f9fa;
    }
    
    .file-upload:hover {
      border-color: #764ba2;
      background: #f0f0f0;
    }
    
    .file-upload.dragover {
      border-color: #764ba2;
      background: #e8e8ff;
    }
    
    .file-upload input[type="file"] {
      display: none;
    }
    
    .file-icon {
      font-size: 32px;
      margin-bottom: 10px;
    }
    
    .file-text {
      color: #666;
      font-size: 14px;
    }
    
    .file-name {
      color: #333;
      font-weight: 600;
      margin-top: 10px;
      font-size: 13px;
    }
    
    button {
      width: 100%;
      padding: 12px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s;
      margin-top: 10px;
    }
    
    button:hover {
      transform: translateY(-2px);
    }
    
    button:active {
      transform: translateY(0);
    }
    
    .loading {
      display: none;
      text-align: center;
      margin-top: 20px;
    }
    
    .spinner {
      display: inline-block;
      width: 20px;
      height: 20px;
      border: 3px solid #f3f3f3;
      border-top: 3px solid #667eea;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    
    .message {
      margin-top: 20px;
      padding: 12px;
      border-radius: 6px;
      display: none;
      font-size: 14px;
    }
    
    .message.success {
      background: #d4edda;
      color: #155724;
      border: 1px solid #c3e6cb;
      display: block;
    }
    
    .message.error {
      background: #f8d7da;
      color: #721c24;
      border: 1px solid #f5c6cb;
      display: block;
    }
    
    .info {
      background: #e7f3ff;
      border: 1px solid #b3d9ff;
      color: #004085;
      padding: 12px;
      border-radius: 6px;
      margin-bottom: 20px;
      font-size: 13px;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>📚 Upload Buku</h1>
    <p class="subtitle">Tambah buku baru ke Pustara</p>
    
    <div class="info">
      ℹ️ <strong>Development Mode:</strong> Endpoint ini untuk testing. Di production, gunakan admin dashboard.
    </div>
    
    <form id="uploadForm">
      <div class="form-group">
        <label for="title">📖 Judul Buku *</label>
        <input type="text" id="title" placeholder="Contoh: Kalkulus I" required>
      </div>
      
      <div class="form-group">
        <label for="authors"> Penulis *</label>
        <input type="text" id="authors" placeholder="Contoh: Purcell, Varberg (pisahkan dengan koma)" required>
      </div>
      
      <div class="form-group">
        <label for="genreSelect"> Genre *</label>
        <div style="display: flex; gap: 10px; align-items: flex-start;">
          <select id="genreSelect" style="flex: 1; padding: 12px; border: 2px solid #e0e0e0; border-radius: 6px; font-size: 14px; font-family: inherit;" required>
            <option value="">-- Pilih Genre --</option>
            <option value="Fiksi">Fiksi</option>
            <option value="Sastra">Sastra</option>
            <option value="Sejarah">Sejarah</option>
            <option value="Sains">Sains</option>
            <option value="Biografi">Biografi</option>
            <option value="Romansa">Romansa</option>
            <option value="Misteri">Misteri</option>
            <option value="Teknologi">Teknologi</option>
            <option value="Pendidikan">Pendidikan</option>
            <option value="Filsafat">Filsafat</option>
            <option value="Psikologi">Psikologi</option>
            <option value="Seni">Seni</option>
            <option value="Agama">Agama</option>
            <option value="Ekonomi">Ekonomi</option>
            <option value="Politik">Politik</option>
            <option value="Olahraga">Olahraga</option>
            <option value="__custom__">🔧 Yang Lain...</option>
          </select>
          <input type="text" id="genreCustom" placeholder="Genre lain" style="flex: 1; padding: 12px; border: 2px solid #e0e0e0; border-radius: 6px; font-size: 14px; font-family: inherit; display: none;">
        </div>
        <small style="color: #999; margin-top: 5px; display: block;">💡 Pilih dari list atau masukkan genre custom (bisa lebih dari 1, pisahkan dengan koma)</small>
      </div>
      
      <div class="form-group">
        <label for="isbn">📚 ISBN</label>
        <input type="text" id="isbn" placeholder="Contoh: 978-9793061621 (opsional - untuk auto-fetch cover)" pattern="[0-9\-]*">
        <small style="color: #999; margin-top: 5px; display: block;">💡 Masukkan ISBN untuk auto-fetch cover dari OpenLibrary</small>
      </div>
      
      <div class="form-group">
        <label for="description">📝 Deskripsi</label>
        <textarea id="description" placeholder="Deskripsi singkat tentang buku (opsional)" rows="3" style="resize: vertical;"></textarea>
      </div>
      
      <div class="form-group">
        <label for="year">📅 Tahun</label>
        <input type="text" id="year" placeholder="Contoh: 2023">
      </div>
      
      <div class="form-group">
        <label for="pages">📄 Jumlah Halaman</label>
        <input type="text" id="pages" placeholder="Contoh: 450">
      </div>
      
      <div class="form-group">
        <label>📁 File PDF *</label>
        <div class="file-upload" id="fileUpload">
          <div class="file-icon">📄</div>
          <div class="file-text">
            Drag & drop file PDF di sini atau klik untuk browse
          </div>
          <div class="file-name" id="fileName"></div>
          <input type="file" id="bookFile" accept=".pdf" required>
        </div>
      </div>
      
      <button type="submit">✨ Upload Buku</button>
      
      <div class="loading" id="loading">
        <div class="spinner"></div>
        <p style="margin-top: 10px; color: #666;">Uploading...</p>
      </div>
      
      <div class="message" id="message"></div>
    </form>
  </div>

  <script>
    const form = document.getElementById('uploadForm');
    const fileUpload = document.getElementById('fileUpload');
    const fileInput = document.getElementById('bookFile');
    const fileName = document.getElementById('fileName');
    const loading = document.getElementById('loading');
    const messageDiv = document.getElementById('message');
    const genreSelect = document.getElementById('genreSelect');
    const genreCustom = document.getElementById('genreCustom');
    
    // Genre dropdown handler
    genreSelect.addEventListener('change', () => {
      if (genreSelect.value === '__custom__') {
        genreCustom.style.display = 'block';
        genreCustom.required = true;
        genreSelect.required = false;
      } else {
        genreCustom.style.display = 'none';
        genreCustom.required = false;
        genreSelect.required = true;
      }
    });

    // File upload drag and drop
    fileUpload.addEventListener('click', () => fileInput.click());
    
    fileUpload.addEventListener('dragover', (e) => {
      e.preventDefault();
      fileUpload.classList.add('dragover');
    });
    
    fileUpload.addEventListener('dragleave', () => {
      fileUpload.classList.remove('dragover');
    });
    
    fileUpload.addEventListener('drop', (e) => {
      e.preventDefault();
      fileUpload.classList.remove('dragover');
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        fileInput.files = files;
        updateFileName();
      }
    });
    
    fileInput.addEventListener('change', updateFileName);
    
    function updateFileName() {
      if (fileInput.files.length > 0) {
        fileName.textContent = '✅ ' + fileInput.files[0].name;
      } else {
        fileName.textContent = '';
      }
    }
    
    // Form submission
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      if (!fileInput.files.length) {
        showMessage('❌ Pilih file PDF terlebih dahulu', 'error');
        return;
      }
      
      const formData = new FormData();
      formData.append('title', document.getElementById('title').value);
      formData.append('authors', document.getElementById('authors').value);
      
      // Handle genre: if custom selected, use custom input; otherwise use dropdown
      let genreValue = genreSelect.value === '__custom__' 
        ? genreCustom.value 
        : genreSelect.value;
      formData.append('genres', genreValue);
      
      formData.append('isbn', document.getElementById('isbn').value);
      formData.append('description', document.getElementById('description').value);
      formData.append('year', document.getElementById('year').value);
      formData.append('pages', document.getElementById('pages').value);
      formData.append('bookFile', fileInput.files[0]);
      
      loading.style.display = 'block';
      messageDiv.style.display = 'none';
      
      try {
        const response = await fetch('/books/upload-dev', {
          method: 'POST',
          body: formData
        });
        
        const data = await response.json();
        
        if (data.success) {
          showMessage('✅ Buku berhasil diupload!', 'success');
          form.reset();
          fileName.textContent = '';
          setTimeout(() => {
            messageDiv.style.display = 'none';
          }, 3000);
        } else {
          showMessage('❌ Error: ' + (data.message || 'Upload gagal'), 'error');
        }
      } catch (error) {
        showMessage('❌ Error: ' + error.message, 'error');
      } finally {
        loading.style.display = 'none';
      }
    });
    
    function showMessage(text, type) {
      messageDiv.textContent = text;
      messageDiv.className = 'message ' + type;
      messageDiv.style.display = 'block';
    }
  </script>
</body>
</html>
  `;
  
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
};

// DEVELOPMENT ONLY: POST /books/upload-dev - Upload book (no auth)
exports.uploadBookDev = async (req, res) => {
  try {
    const { title, description, year, pages, isbn } = req.body;
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
      return res.status(400).json({ success: false, message: 'Authors is required' });
    }

    // Parse genres - accept string or array
    if (typeof genres === 'string') {
      genres = genres.split(',').map(g => g.trim()).filter(g => g);
    }
    if (!Array.isArray(genres) || genres.length === 0) {
      return res.status(400).json({ success: false, message: 'Genres is required' });
    }

    let fileUrl = null;
    let fileType = 'application/pdf';

    // Upload file to local storage
    if (file) {
      if (!['application/pdf', 'application/x-pdf'].includes(file.mimetype)) {
        return res.status(400).json({ success: false, message: 'Only PDF files are allowed' });
      }

      fileType = file.mimetype;
      const fileName = `${uuidv4()}-${Date.now()}.pdf`;
      
      try {
        // Read file data (handle both temp file and in-memory data)
        let fileBuffer;
        if (file.tempFilePath) {
          // If using temp files, read from disk
          const fs = require('fs');
          fileBuffer = fs.readFileSync(file.tempFilePath);
          console.log(`📄 Read PDF from temp: ${file.tempFilePath} (${fileBuffer.length} bytes)`);
        } else {
          // Fallback to in-memory data
          fileBuffer = file.data;
          console.log(`📄 Using in-memory PDF data (${fileBuffer.length} bytes)`);
        }

        // Check file size
        if (!fileBuffer || fileBuffer.length === 0) {
          return res.status(400).json({ success: false, message: 'PDF file is empty (0 bytes)' });
        }

        // DEVELOPMENT: Upload to local storage
        fileUrl = await storage.uploadFile(fileName, fileBuffer, fileType);
      } catch (uploadError) {
        console.error('Storage upload error:', uploadError.message);
        return res.status(500).json({ success: false, message: 'Failed to upload file to storage' });
      }
    } else {
      return res.status(400).json({ success: false, message: 'PDF file is required' });
    }

    // Fetch cover from OpenLibrary if ISBN provided
    let coverId = null;
    let openLibraryData = null;

    if (isbn && isbn.trim().length > 0) {
      const openLibraryService = require('../services/openLibraryService');
      try {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`📖 STARTING ISBN COVER LOOKUP`);
        console.log(`ISBN provided: ${isbn}`);
        console.log(`ISBN type: ${typeof isbn}`);
        console.log(`ISBN length: ${isbn.length}`);
        console.log(`${'='.repeat(60)}\n`);
        
        openLibraryData = await openLibraryService.fetchBookByISBN(isbn);
        
        if (openLibraryData) {
          coverId = openLibraryData.cover_id;
          console.log(`\n✅ SUCCESS - Cover ID retrieved: ${coverId}`);
          console.log(`Book Title: ${openLibraryData.title}`);
          console.log(`Authors: ${openLibraryData.authors.join(', ')}`);
        } else {
          console.warn(`\n⚠️  OpenLibrary returned null - no data found for ISBN: ${isbn}`);
        }
      } catch (error) {
        console.error(`\n❌ Error fetching from OpenLibrary: ${error.message}`);
        console.error(error);
        // Continue anyway, cover is optional
      }
    } else {
      console.log(`[Upload] No ISBN provided - skipping cover lookup`);
    }

    // Insert to database
    const pool = require('../config/database').getPool();
    const query = `
      INSERT INTO books (title, authors, genres, description, year, pages, language, isbn, cover_id, file_url, file_type, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)
      RETURNING *
    `;

    const result = await pool.query(query, [
      title,
      JSON.stringify(authors),
      JSON.stringify(genres),
      description || null,
      year ? parseInt(year) : null,
      pages ? parseInt(pages) : null,
      'id',
      isbn && isbn.trim().length > 0 ? isbn.replace(/[-\s]/g, '') : null,
      coverId,
      fileUrl,
      fileType
    ]);

    if (!result || !result.rows || result.rows.length === 0) {
      return res.status(500).json({ success: false, message: 'Failed to save book to database' });
    }

    const bookData = result.rows[0];

    res.status(201).json({
      success: true,
      message: '✅ Book uploaded successfully' + (coverId ? ' with cover!' : ''),
      data: {
        id: bookData.id,
        title: bookData.title,
        authors: bookData.authors,
        genres: bookData.genres,
        isbn: bookData.isbn,
        cover_id: bookData.cover_id,
        file_url: bookData.file_url,
        file_type: bookData.file_type
      }
    });
  } catch (error) {
    console.error('Error uploading book (dev):', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// REVIEW ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

// POST /reviews - Create or update a review
exports.createOrUpdateReview = async (req, res) => {
  try {
    const { book_id, rating, review_text } = req.body;
    const firebase_uid = req.user?.uid; // From Firebase token
    console.log('[DEBUG] Received review submission:', { book_id, firebase_uid, rating, review_text });

    // Validation
    if (!book_id || !rating) {
      return res.status(400).json({ success: false, message: 'book_id and rating are required' });
    }

    if (!firebase_uid) {
      return res.status(401).json({ success: false, message: 'User authentication required' });
    }

    if (rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: 'Rating must be between 1 and 5' });
    }

    const pool = require('../config/database').getPool();

    // Lookup user's UUID from firebase_uid
    const userLookupQuery = 'SELECT id FROM users WHERE firebase_uid = $1';
    const userResult = await pool.query(userLookupQuery, [firebase_uid]);
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found - please complete profile setup' });
    }
    
    const user_id = userResult.rows[0].id; // This is the UUID
    console.log('[DEBUG] User UUID resolved:', user_id);

    // Check if review exists
    const checkQuery = 'SELECT id FROM reviews WHERE user_id = $1 AND book_id = $2';
    const checkResult = await pool.query(checkQuery, [user_id, book_id]);
    console.log('[DEBUG] Existing review check:', checkResult.rows.length > 0 ? 'Found' : 'Not found');

    let result;
    if (checkResult.rows.length > 0) {
      // Update existing review
      const updateQuery = `
        UPDATE reviews 
        SET rating = $1, review_text = $2, updated_at = NOW()
        WHERE user_id = $3 AND book_id = $4
        RETURNING *
      `;
      result = await pool.query(updateQuery, [rating, review_text || null, user_id, book_id]);
      console.log('[DEBUG] Review updated');
    } else {
      // Create new review
      const insertQuery = `
        INSERT INTO reviews (user_id, book_id, rating, review_text, created_at, updated_at)
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        RETURNING *
      `;
      result = await pool.query(insertQuery, [user_id, book_id, rating, review_text || null]);
      console.log('[DEBUG] Review created');
    }

    const review = result.rows[0];

    // Recalculate book's average rating and review count
    const statsQuery = `
      SELECT 
        COUNT(*) as rating_count,
        ROUND(AVG(rating)::numeric, 2) as avg_rating
      FROM reviews
      WHERE book_id = $1
    `;
    const statsResult = await pool.query(statsQuery, [book_id]);
    const stats = statsResult.rows[0];
    console.log('[DEBUG] Calculated stats:', stats);

    // Update book's avg_rating and rating_count
    const updateBookQuery = `
      UPDATE books 
      SET avg_rating = $1, rating_count = $2, updated_at = NOW()
      WHERE id = $3
      RETURNING avg_rating, rating_count, id
    `;
    const updateResult = await pool.query(updateBookQuery, [
      parseFloat(stats.avg_rating) || 0,
      parseInt(stats.rating_count) || 0,
      book_id
    ]);
    const updatedStats = updateResult.rows[0];
    console.log('[DEBUG] Book stats updated:', updatedStats);
    console.log(`✅ Book ${book_id} updated: avg_rating=${stats.avg_rating}, rating_count=${stats.rating_count}`);

    // Fetch fresh book data to return
    const freshBookQuery = 'SELECT * FROM books WHERE id = $1';
    const freshBookResult = await pool.query(freshBookQuery, [book_id]);
    const freshBook = freshBookResult.rows[0];
    console.log('[DEBUG] Fresh book data retrieved:', { avg_rating: freshBook.avg_rating, rating_count: freshBook.rating_count });

    const responseData = {
      success: true,
      message: checkResult.rows.length > 0 ? 'Review updated' : 'Review created',
      data: {
        review: {
          id: review.id,
          user_id: review.user_id,
          book_id: review.book_id,
          rating: review.rating,
          review_text: review.review_text,
          created_at: review.created_at,
          updated_at: review.updated_at,
        },
        book_stats: {
          avg_rating: parseFloat(freshBook.avg_rating) || 0,
          rating_count: parseInt(freshBook.rating_count) || 0
        },
        updated_book: freshBook
      }
    };
    
    console.log('[DEBUG] ✅ FINAL RESPONSE TO CLIENT:', JSON.stringify({
      book_id,
      book_stats: responseData.data.book_stats,
      updated_book_ratings: {
        avg_rating: freshBook.avg_rating,
        rating_count: freshBook.rating_count
      }
    }, null, 2));

    res.status(201).json(responseData);
  } catch (error) {
    console.error('Error creating/updating review:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /books/:bookId/reviews - Get all reviews for a book
exports.getBookReviews = async (req, res) => {
  try {
    const { id: bookId } = req.params;  // Route param is :id, not :bookId
    const { limit = 50, offset = 0 } = req.query;

    const pool = require('../config/database').getPool();

    // Get reviews with user info
    const query = `
      SELECT 
        r.id,
        r.user_id,
        r.book_id,
        r.rating,
        r.review_text,
        r.created_at,
        r.updated_at,
        u.username as name,
        SUBSTRING(u.username, 1, 1) as avatar
      FROM reviews r
      LEFT JOIN users u ON r.user_id = u.id
      WHERE r.book_id = $1
      ORDER BY r.created_at DESC
      LIMIT $2 OFFSET $3
    `;

    const result = await pool.query(query, [bookId, limit, offset]);

    // Get total count
    const countQuery = 'SELECT COUNT(*) as total FROM reviews WHERE book_id = $1';
    const countResult = await pool.query(countQuery, [bookId]);

    const reviews = result.rows.map(r => ({
      id: r.id,
      user_id: r.user_id,
      name: r.name || 'Anonymous',
      avatar: r.avatar || 'U',
      rating: r.rating,
      text: r.review_text,
      time: r.created_at ? new Date(r.created_at).toLocaleDateString('id-ID') : '-',
      likes: 0 // Placeholder for future implementation
    }));

    res.json({
      success: true,
      data: reviews,
      pagination: {
        total: parseInt(countResult.rows[0].total),
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });
  } catch (error) {
    console.error('Error fetching reviews:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

