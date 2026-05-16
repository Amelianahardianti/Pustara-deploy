/**
 * Shelf Controller
 * Handles user shelf data: loans, reading sessions, wishlist, history
 */

const db = require('../config/database');
const UserService = require('../services/userService');
const { pushActivity } = require('../services/redis');
const { insertNotification, getUserContact } = require('../services/notificationService');
const { sendEmail } = require('../services/emailService');

function toRows(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.rows)) return result.rows;
  if (result && Array.isArray(result.recordset)) return result.recordset;
  return [];
}

function parseStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return [];

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item).trim()).filter(Boolean);
      }
    } catch (_) {
      // fallback to comma split
    }

    return raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function formatBook(row) {
  return {
    id: String(row.id || ''),
    title: String(row.title || ''),
    authors: parseStringArray(row.authors),
    genres: parseStringArray(row.genres),
    cover_url: row.cover_url ? String(row.cover_url) : '',
    avg_rating: Number(row.avg_rating || 0),
    year: Number(row.year || 0),
    pages: Number(row.pages || 0),
  };
}

async function safeRows(query, params, label) {
  try {
    const result = await db.executeQuery(query, params);
    return toRows(result);
  } catch (error) {
    console.error(`Error fetching shelf ${label}:`, error.message);
    return [];
  }
}

async function resolveActorUserId(req) {
  if (!req.user?.uid) return null;

  const actor = await UserService.getUserByUid(req.user.uid);
  if (!actor.success || !actor.data?.id) return null;

  return String(actor.data.id);
}

async function getActiveLoan(userId, bookId) {
  const rows = toRows(
    await db.executeQuery(
      `SELECT id, user_id, book_id, borrowed_at,
              COALESCE(due_date, due_at) AS due_date,
              due_at,
              returned_at,
              status,
              extended
       FROM loans
       WHERE user_id = $1 AND book_id = $2 AND returned_at IS NULL
       ORDER BY borrowed_at DESC
       LIMIT 1`,
      [userId, bookId]
    )
  );
  return rows[0] || null;
}

async function getActiveLoanById(userId, loanId) {
  const rows = toRows(
    await db.executeQuery(
      `SELECT id, user_id, book_id, borrowed_at,
              COALESCE(due_date, due_at) AS due_date,
              due_at,
              returned_at,
              status,
              extended
       FROM loans
       WHERE user_id = $1 AND id = $2 AND returned_at IS NULL
       LIMIT 1`,
      [userId, loanId]
    )
  );

  return rows[0] || null;
}

async function getWishlistRow(userId, bookId) {
  try {
    const rows = toRows(
      await db.executeQuery(
        `SELECT user_id, book_id, added_at
         FROM wishlist
         WHERE user_id = $1 AND book_id = $2
         ORDER BY added_at DESC
         LIMIT 1`,
        [userId, bookId]
      )
    );
    return rows[0] || null;
  } catch (_) {
    const rows = toRows(
      await db.executeQuery(
        `SELECT user_id, book_id, created_at AS added_at
         FROM wishlist
         WHERE user_id = $1 AND book_id = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [userId, bookId]
      )
    );
    return rows[0] || null;
  }
}

async function getWishlistRowsByUser(userId) {
  try {
    return toRows(
      await db.executeQuery(
        `SELECT b.id, b.title, b.authors, b.genres, b.cover_url, b.avg_rating, b.year, b.pages,
                w.book_id as wishlist_id, w.added_at
         FROM wishlist w
         JOIN books b ON b.id = w.book_id
         WHERE w.user_id = $1
           AND b.is_active = true
         ORDER BY w.added_at DESC`,
        [userId]
      )
    );
  } catch (_) {
    return toRows(
      await db.executeQuery(
        `SELECT b.id, b.title, b.authors, b.genres, b.cover_url, b.avg_rating, b.year, b.pages,
                w.book_id as wishlist_id, w.created_at AS added_at
         FROM wishlist w
         JOIN books b ON b.id = w.book_id
         WHERE w.user_id = $1
           AND b.is_active = true
         ORDER BY w.created_at DESC`,
        [userId]
      )
    );
  }
}

async function ensureReadingSession(userId, bookId) {
  const existingRows = toRows(
    await db.executeQuery(
      `SELECT id
       FROM reading_sessions
       WHERE user_id = $1 AND book_id = $2 AND status IN ('reading', 'active')
       ORDER BY started_at DESC
       LIMIT 1`,
      [userId, bookId]
    )
  );

  if (existingRows.length > 0) return existingRows[0];

  const bookRows = toRows(
    await db.executeQuery(
      'SELECT pages FROM books WHERE id = $1 AND is_active = true LIMIT 1',
      [bookId]
    )
  );
  const totalPages = Number(bookRows[0]?.pages || 0);

  const initialPage = totalPages > 0 ? 1 : 0;

  const createdRows = toRows(
    await db.executeQuery(
      `INSERT INTO reading_sessions
       (user_id, book_id, current_page, total_pages, progress_percentage, status, started_at)
       VALUES ($1, $2, $3, $4, 0, 'reading', CURRENT_TIMESTAMP)
       RETURNING id, started_at`,
      [userId, bookId, initialPage, totalPages]
    )
  );

  return createdRows[0] || null;
}

async function notifyUserAndSendEmail({ userId, type, title, body, bookId = null, emailSubject }) {
  await insertNotification({ userId, type, title, body, bookId });

  const contact = await getUserContact(userId);
  if (!contact?.email) return;

  const textBody = [
    `Halo ${contact.name || 'Pustara Reader'},`,
    '',
    body,
    '',
    'Buka Pustara untuk detail lebih lanjut.',
  ].join('\n');

  try {
    await sendEmail({
      to: contact.email,
      subject: emailSubject || title,
      text: textBody,
    });
  } catch (error) {
    console.warn('[Shelf] Failed to send user email:', error.message);
  }
}

exports.getMyBookStatus = async (req, res) => {
  try {
    const actorUserId = await resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const { bookId } = req.params;
    const [loan, wishlist] = await Promise.all([
      getActiveLoan(actorUserId, bookId),
      getWishlistRow(actorUserId, bookId),
    ]);

    res.json({
      success: true,
      data: {
        borrowed: Boolean(loan),
        wishlisted: Boolean(wishlist),
        loan_id: loan ? String(loan.id) : null,
        wishlist_id: wishlist ? String(wishlist.book_id || bookId) : null,
      },
    });
  } catch (error) {
    console.error('Error fetching book shelf status:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch book status', error: error.message });
  }
};

exports.borrowBook = async (req, res) => {
  try {
    const actorUserId = await resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const { bookId } = req.params;
    const bookRows = toRows(
      await db.executeQuery(
        'SELECT id, title, available, is_active FROM books WHERE id = $1 LIMIT 1',
        [bookId]
      )
    );

    if (bookRows.length === 0 || !bookRows[0].is_active) {
      return res.status(404).json({ success: false, message: 'Book not found' });
    }

    const book = bookRows[0];
    const available = Number(book.available || 0);

    const existingLoan = await getActiveLoan(actorUserId, bookId);
    if (existingLoan) {
      await ensureReadingSession(actorUserId, bookId);
      return res.json({
        success: true,
        message: 'Book already borrowed',
        data: {
          loan_id: String(existingLoan.id),
          borrowed: true,
          due_date: existingLoan.due_date || existingLoan.due_at || null,
        },
      });
    }

    if (available <= 0) {
      return res.status(409).json({ success: false, message: 'Book is not available right now' });
    }

    const dueDateRows = toRows(await db.executeQuery("SELECT CURRENT_TIMESTAMP + INTERVAL '7 days' AS due_date"));
    const dueDate = dueDateRows[0]?.due_date || null;

    const loanRows = toRows(
      await db.executeQuery(
        `INSERT INTO loans (user_id, book_id, borrowed_at, due_at, returned_at)
         VALUES ($1, $2, CURRENT_TIMESTAMP, $3, NULL)
         RETURNING id, borrowed_at, COALESCE(due_date, due_at) AS due_date, due_at`,
        [actorUserId, bookId, dueDate]
      )
    );

    await db.executeQuery(
      'UPDATE books SET available = GREATEST(COALESCE(available, 0) - 1, 0) WHERE id = $1',
      [bookId]
    );

    await ensureReadingSession(actorUserId, bookId);

    if (req.user?.uid) {
      pushActivity(req.user.uid, bookId, 'read').catch((err) => {
        console.warn('[Shelf] pushActivity(read) warning:', err?.message || err);
      });
    }

    const loan = loanRows[0] || {};

    await notifyUserAndSendEmail({
      userId: actorUserId,
      type: 'borrow',
      title: 'Peminjaman Berhasil',
      body: `Buku \"${book.title}\" berhasil dipinjam. Tenggat pengembalian: 7 hari dari sekarang.`,
      bookId,
      emailSubject: 'Pustara - Konfirmasi Peminjaman Buku',
    });

    res.status(201).json({
      success: true,
      message: 'Book borrowed successfully',
      data: {
        loan_id: loan.id ? String(loan.id) : null,
        borrowed: true,
        borrowed_at: loan.borrowed_at || null,
        due_date: loan.due_date || loan.due_at || dueDate,
      },
    });
  } catch (error) {
    console.error('Error borrowing book:', error.message);
    res.status(500).json({ success: false, message: 'Failed to borrow book', error: error.message });
  }
};

exports.returnBook = async (req, res) => {
  try {
    const actorUserId = await resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const loanOrBookId = req.params.loanOrBookId || req.params.bookId || req.params.loanId;
    if (!loanOrBookId) {
      return res.status(400).json({ success: false, message: 'loanId or bookId is required' });
    }

    let activeLoan = await getActiveLoanById(actorUserId, loanOrBookId);
    if (!activeLoan) {
      activeLoan = await getActiveLoan(actorUserId, loanOrBookId);
    }

    if (!activeLoan) {
      return res.json({
        success: true,
        message: 'No active loan found',
        data: { borrowed: false, returned: true },
      });
    }

    const sessionRows = toRows(
      await db.executeQuery(
        `SELECT id, status, current_page, total_pages, progress_percentage, finished_at
         FROM reading_sessions
         WHERE user_id = $1 AND book_id = $2
         ORDER BY COALESCE(finished_at, last_read_at, started_at) DESC
         LIMIT 1`,
        [actorUserId, activeLoan.book_id]
      )
    );
    const latestSession = sessionRows[0] || null;
    const progressPercentage = Number(latestSession?.progress_percentage || 0);
    const currentPage = Number(latestSession?.current_page || 0);
    const totalPages = Number(latestSession?.total_pages || 0);
    const sessionIsFinished = Boolean(
      latestSession && (
        String(latestSession.status || '').toLowerCase() === 'finished' ||
        progressPercentage >= 100 ||
        (totalPages > 0 && currentPage >= totalPages)
      )
    );

    await db.executeQuery(
      `UPDATE loans
       SET returned_at = CURRENT_TIMESTAMP, status = 'returned'
       WHERE id = $1 AND user_id = $2 AND returned_at IS NULL`,
      [activeLoan.id, actorUserId]
    );

    await db.executeQuery(
      'UPDATE books SET available = LEAST(COALESCE(available, 0) + 1, COALESCE(total_stock, available + 1)) WHERE id = $1',
      [activeLoan.book_id]
    );

    if (latestSession?.id) {
      await db.executeQuery(
        sessionIsFinished
          ? `UPDATE reading_sessions
             SET status = 'finished',
                 finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP),
                 progress_percentage = GREATEST(COALESCE(progress_percentage, 0), 100)
             WHERE id = $1 AND user_id = $2`
          : `UPDATE reading_sessions
             SET status = CASE WHEN status = 'finished' THEN status ELSE 'paused' END
             WHERE id = $1 AND user_id = $2 AND status IN ('reading', 'active', 'paused')`,
        [latestSession.id, actorUserId]
      );
    }
    
    const returnedBookRows = toRows(
      await db.executeQuery('SELECT title FROM books WHERE id = $1 LIMIT 1', [activeLoan.book_id])
    );
    const returnedTitle = String(returnedBookRows[0]?.title || 'Buku');

    await notifyUserAndSendEmail({
      userId: actorUserId,
      type: 'system',
      title: 'Pengembalian Berhasil',
      body: `Buku \"${returnedTitle}\" sudah berhasil dikembalikan. Terima kasih sudah membaca di Pustara.`,
      bookId: activeLoan.book_id,
      emailSubject: 'Pustara - Pengembalian Buku Berhasil',
    });

    res.json({
      success: true,
      message: 'Book returned successfully',
      data: {
        loan_id: String(activeLoan.id),
        book_id: String(activeLoan.book_id || ''),
        borrowed: false,
        returned: true,
      },
    });
  } catch (error) {
    console.error('Error returning book:', error.message);
    res.status(500).json({ success: false, message: 'Failed to return book', error: error.message });
  }
};

exports.extendLoan = async (req, res) => {
  try {
    const actorUserId = await resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const { loanId } = req.params;
    if (!loanId) {
      return res.status(400).json({ success: false, message: 'loanId is required' });
    }

    const loanRows = toRows(
      await db.executeQuery(
        `SELECT id, user_id, book_id, returned_at, extended, status,
                COALESCE(due_date, due_at) AS due_base
         FROM loans
         WHERE id = $1 AND user_id = $2
         LIMIT 1`,
        [loanId, actorUserId]
      )
    );

    const loan = loanRows[0];
    if (!loan) {
      return res.status(404).json({ success: false, message: 'Loan not found' });
    }

    if (loan.returned_at) {
      return res.status(409).json({ success: false, message: 'Loan already returned' });
    }

    if (Boolean(loan.extended)) {
      return res.status(409).json({ success: false, message: 'Loan already extended once' });
    }

    if (String(loan.status || '').toLowerCase() === 'overdue') {
      return res.status(409).json({ success: false, message: 'Overdue loan cannot be extended' });
    }

    const updatedRows = toRows(
      await db.executeQuery(
        `UPDATE loans
         SET due_at = COALESCE(due_at, CURRENT_TIMESTAMP) + INTERVAL '3 days',
             extended = true,
             status = 'extended'
         WHERE id = $1 AND user_id = $2 AND returned_at IS NULL
         RETURNING id, book_id, COALESCE(due_date, due_at) AS due_date, due_at, extended, status`,
        [loanId, actorUserId]
      )
    );

    const updated = updatedRows[0] || null;

    const extendedBookRows = toRows(
      await db.executeQuery('SELECT title FROM books WHERE id = $1 LIMIT 1', [updated?.book_id || loan.book_id])
    );
    const extendedTitle = String(extendedBookRows[0]?.title || 'Buku');

    await notifyUserAndSendEmail({
      userId: actorUserId,
      type: 'due',
      title: 'Peminjaman Diperpanjang',
      body: `Peminjaman buku \"${extendedTitle}\" diperpanjang 3 hari. Pastikan dikembalikan sebelum tenggat baru.`,
      bookId: updated?.book_id || loan.book_id,
      emailSubject: 'Pustara - Perpanjangan Peminjaman',
    });

    return res.json({
      success: true,
      message: 'Loan extended by 3 days',
      data: {
        loan_id: String(updated?.id || loanId),
        book_id: String(updated?.book_id || loan.book_id || ''),
        due_date: updated?.due_date || updated?.due_at || null,
        status: updated?.status || 'extended',
        extended: true,
      },
    });
  } catch (error) {
    console.error('Error extending loan:', error.message);
    res.status(500).json({ success: false, message: 'Failed to extend loan', error: error.message });
  }
};

exports.addToWishlist = async (req, res) => {
  try {
    const actorUserId = await resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const { bookId } = req.params;
    const existing = await getWishlistRow(actorUserId, bookId);
    if (existing) {
      return res.json({
        success: true,
        message: 'Book already in wishlist',
        data: { wishlist_id: String(existing.book_id || bookId), wishlisted: true },
      });
    }

    let rows = [];
    try {
      rows = toRows(
        await db.executeQuery(
          `INSERT INTO wishlist (user_id, book_id, added_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP)
           RETURNING book_id, added_at`,
          [actorUserId, bookId]
        )
      );
    } catch (_) {
      rows = toRows(
        await db.executeQuery(
          `INSERT INTO wishlist (user_id, book_id, created_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP)
           RETURNING book_id, created_at AS added_at`,
          [actorUserId, bookId]
        )
      );
    }

    if (req.user?.uid) {
      pushActivity(req.user.uid, bookId, 'wishlist').catch((err) => {
        console.warn('[Shelf] pushActivity(wishlist) warning:', err?.message || err);
      });
    }

    res.status(201).json({
      success: true,
      message: 'Book saved to wishlist',
      data: {
        wishlist_id: rows[0]?.book_id ? String(rows[0].book_id) : String(bookId),
        wishlisted: true,
      },
    });
  } catch (error) {
    console.error('Error adding wishlist:', error.message);
    res.status(500).json({ success: false, message: 'Failed to add wishlist', error: error.message });
  }
};

exports.removeFromWishlist = async (req, res) => {
  try {
    const actorUserId = await resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const { bookId } = req.params;
    await db.executeQuery('DELETE FROM wishlist WHERE user_id = $1 AND book_id = $2', [actorUserId, bookId]);

    res.json({
      success: true,
      message: 'Book removed from wishlist',
      data: { wishlisted: false },
    });
  } catch (error) {
    console.error('Error removing wishlist:', error.message);
    res.status(500).json({ success: false, message: 'Failed to remove wishlist', error: error.message });
  }
};

/**
 * GET /shelf/me
 * Returns comprehensive shelf data with duplicate key fixes.
 */
exports.getMyShelf = async (req, res) => {
  try {
    const actorUserId = await resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const [borrowedRows, readingNowRows, historyRows, wishlistRows] = await Promise.all([
      // Active loans
      safeRows(
        `SELECT * FROM (
             SELECT DISTINCT ON (b.id) 
                    b.id, b.title, b.authors, b.genres, b.cover_url, b.avg_rating, b.year, b.pages,
                    l.id as loan_id, l.borrowed_at, COALESCE(l.due_date, l.due_at) AS due_date, l.returned_at,
                    l.status as loan_status,
                    COALESCE(rs.progress_percentage, 0) as progress_percentage
             FROM loans l
             JOIN books b ON b.id = l.book_id
             LEFT JOIN LATERAL (
               SELECT progress_percentage, started_at
               FROM reading_sessions
               WHERE book_id = l.book_id AND user_id = l.user_id AND status IN ('reading', 'active', 'paused')
               ORDER BY started_at DESC LIMIT 1
             ) rs ON true
             WHERE l.user_id = $1 AND b.is_active = true AND l.returned_at IS NULL AND l.status IN ('active', 'extended')
             ORDER BY b.id, l.borrowed_at DESC
           ) sub
           ORDER BY borrowed_at DESC`,
        [actorUserId],
        'borrowed'
      ),
      // Currently reading sessions
      safeRows(
        `SELECT * FROM (
             SELECT DISTINCT ON (b.id) 
                    b.id, b.title, b.authors, b.genres, b.cover_url, b.avg_rating, b.year, b.pages,
                    rs.id as session_id, rs.current_page, rs.total_pages, 
                    rs.progress_percentage, rs.last_read_at, rs.started_at
             FROM reading_sessions rs
             JOIN books b ON b.id = rs.book_id
             WHERE rs.user_id = $1
               AND b.is_active = true
               AND rs.status IN ('reading', 'active', 'paused')
               AND EXISTS (
                 SELECT 1 FROM loans l 
                 WHERE l.book_id = rs.book_id AND l.user_id = rs.user_id AND l.returned_at IS NULL
               )
               AND (rs.current_page > 1 OR rs.progress_percentage > 0)
             ORDER BY b.id, rs.last_read_at DESC NULLS LAST, rs.started_at DESC
           ) sub
           ORDER BY last_read_at DESC NULLS LAST`,
        [actorUserId],
        'reading'
      ),
      // History items: returned loans + finished reading sessions that are not tied to a returned loan
      safeRows(
        `SELECT * FROM (
             SELECT
               b.id, b.title, b.authors, b.genres, b.cover_url, b.avg_rating, b.year, b.pages,
               l.id AS loan_id,
               l.borrowed_at,
               COALESCE(l.due_date, l.due_at) AS due_date,
               l.returned_at,
               rs.id AS session_id,
               rs.current_page,
               rs.total_pages,
               rs.progress_percentage,
               rs.finished_at,
               rs.started_at,
               rs.reading_time_minutes,
               CASE
                 WHEN l.returned_at IS NOT NULL
                  AND COALESCE(l.due_date, l.due_at) IS NOT NULL
                  AND l.returned_at > COALESCE(l.due_date, l.due_at) THEN 'overdue'
                 WHEN rs.id IS NULL THEN 'unfinished'
                 WHEN COALESCE(rs.progress_percentage, 0) >= 100
                   OR COALESCE(rs.current_page, 0) >= COALESCE(rs.total_pages, 0) THEN 'finished'
                 ELSE 'unfinished'
               END AS history_status,
               COALESCE(l.returned_at, rs.finished_at) AS history_at
             FROM loans l
             JOIN books b ON b.id = l.book_id
             LEFT JOIN LATERAL (
               SELECT id, current_page, total_pages, progress_percentage, finished_at, started_at, reading_time_minutes
               FROM reading_sessions
               WHERE book_id = l.book_id AND user_id = l.user_id
               ORDER BY COALESCE(finished_at, last_read_at, started_at) DESC
               LIMIT 1
             ) rs ON true
             WHERE l.user_id = $1
               AND b.is_active = true
               AND l.returned_at IS NOT NULL

             UNION ALL

             SELECT
               b.id, b.title, b.authors, b.genres, b.cover_url, b.avg_rating, b.year, b.pages,
               NULL AS loan_id,
               NULL AS borrowed_at,
               NULL AS due_date,
               NULL AS returned_at,
               rs.id AS session_id,
               rs.current_page,
               rs.total_pages,
               rs.progress_percentage,
               rs.finished_at,
               rs.started_at,
               rs.reading_time_minutes,
               CASE
                 WHEN COALESCE(rs.progress_percentage, 0) < 100
                  OR COALESCE(rs.current_page, 0) < COALESCE(rs.total_pages, 0) THEN 'unfinished'
                 ELSE 'finished'
               END AS history_status,
               rs.finished_at AS history_at
             FROM reading_sessions rs
             JOIN books b ON b.id = rs.book_id
             WHERE rs.user_id = $1
               AND b.is_active = true
               AND rs.status = 'finished'
               AND NOT EXISTS (
                 SELECT 1
                 FROM loans l
                 WHERE l.book_id = rs.book_id
                   AND l.user_id = rs.user_id
                   AND l.returned_at IS NOT NULL
               )
           ) sub
           ORDER BY history_at DESC NULLS LAST`,
        [actorUserId],
        'history'
      ),
      getWishlistRowsByUser(actorUserId).catch((error) => {
        console.error('Error fetching shelf wishlist:', error.message);
        return [];
      }),
    ]);

    const pinjaman = borrowedRows.map((row) => ({
      ...formatBook(row),
      loan_id: String(row.loan_id || ''),
      borrowed_at: row.borrowed_at || null,
      due_date: row.due_date || null,
      returned_at: row.returned_at || null,
      status: String(row.loan_status || 'active'),
      progress: Number(row.progress_percentage || 0),
      progress_percentage: Number(row.progress_percentage || 0),
      days_left: row.due_date
        ? Math.max(0, Math.floor((new Date(row.due_date) - new Date()) / (1000 * 60 * 60 * 24)))
        : null,
    }));

    const dibaca = readingNowRows.map((row) => ({
      ...formatBook(row),
      session_id: String(row.session_id || ''),
      current_page: Number(row.current_page || 0),
      total_pages: Number(row.total_pages || 0),
      progress_percentage: Number(row.progress_percentage || 0),
      last_read_at: row.last_read_at || null,
      started_at: row.started_at || null,
    }));

    const riwayat = historyRows.map((row) => ({
      ...formatBook(row),
      loan_id: row.loan_id ? String(row.loan_id) : null,
      session_id: row.session_id ? String(row.session_id) : null,
      returned_at: row.returned_at || null,
      finished_at: row.finished_at || null,
      started_at: row.started_at || null,
      reading_time_minutes: Number(row.reading_time_minutes || 0),
      progress_percentage: Number(row.progress_percentage || 0),
      current_page: Number(row.current_page || 0),
      total_pages: Number(row.total_pages || 0),
      status: String(row.history_status || 'finished'),
      days_read: row.started_at && row.finished_at
        ? Math.max(1, Math.floor((new Date(row.finished_at) - new Date(row.started_at)) / (1000 * 60 * 60 * 24)))
        : row.borrowed_at && row.returned_at
          ? Math.max(1, Math.floor((new Date(row.returned_at) - new Date(row.borrowed_at)) / (1000 * 60 * 60 * 24)))
          : null,
    }));

    const wishlist = wishlistRows.map((row) => ({
      ...formatBook(row),
      wishlist_id: String(row.wishlist_id || ''),
      added_at: row.added_at || null,
    }));

    res.json({
      success: true,
      data: {
        pinjaman,
        dibaca,
        riwayat,
        wishlist,
        stats: {
          total_borrowed: pinjaman.length,
          total_reading: dibaca.length,
          total_wishlist: wishlist.length,
          total_read: riwayat.filter((item) => String(item.status || '').toLowerCase() === 'finished').length,
          total_overdue: riwayat.filter((item) => String(item.status || '').toLowerCase() === 'overdue').length,
        },
      },
    });
  } catch (error) {
    console.error('Error fetching shelf data:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch shelf data',
      error: error.message,
    });
  }
};