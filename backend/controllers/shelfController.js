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

const SHELF_TIME_ZONE = 'Asia/Jakarta';
const SHELF_DAY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: SHELF_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const QUEUE_PICKUP_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

function toDayKeyInTimeZone(input) {
  if (!input) return null;

  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return null;

  const parts = SHELF_DAY_FORMATTER.formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;

  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
}

function calculateInclusiveDays(startAt, endAt) {
  const startKey = toDayKeyInTimeZone(startAt);
  const endKey = toDayKeyInTimeZone(endAt);

  if (!startKey || !endKey) return null;

  const startDate = new Date(`${startKey}T00:00:00Z`);
  const endDate = new Date(`${endKey}T00:00:00Z`);
  const diffDays = Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));

  return Math.max(1, diffDays + 1);
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
                COALESCE(b.available, 0) AS available,
                COALESCE(b.total_stock, 0) AS total_stock,
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
                COALESCE(b.available, 0) AS available,
                COALESCE(b.total_stock, 0) AS total_stock,
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

function queueJoinedAtMs(row) {
  const raw = row?.added_at || row?.joined_at || row?.created_at || row?.updated_at || null;
  if (!raw) return Number.MAX_SAFE_INTEGER;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
}

function normalizeQueueRows(rows) {
  const sorted = [...rows].sort((a, b) => {
    const posA = Number(a?.position || 0);
    const posB = Number(b?.position || 0);
    const hasPosA = Number.isFinite(posA) && posA > 0;
    const hasPosB = Number.isFinite(posB) && posB > 0;

    if (hasPosA && hasPosB && posA !== posB) return posA - posB;
    if (hasPosA !== hasPosB) return hasPosA ? -1 : 1;

    const joinDelta = queueJoinedAtMs(a) - queueJoinedAtMs(b);
    if (joinDelta !== 0) return joinDelta;

    return String(a?.id || '').localeCompare(String(b?.id || ''));
  });

  return sorted.map((row, index) => ({
    ...row,
    normalized_position: index + 1,
  }));
}

async function getQueueRowsByBook(bookId) {
  try {
    const rows = toRows(
      await db.executeQuery(
        'SELECT * FROM queue WHERE book_id = $1',
        [bookId]
      )
    );
    return normalizeQueueRows(rows);
  } catch {
    return [];
  }
}

async function normalizeQueuePositions(bookId) {
  const rows = await getQueueRowsByBook(bookId);

  for (const row of rows) {
    const current = Number(row?.position || 0);
    const target = Number(row?.normalized_position || 0);
    if (!row?.id || !target || current === target) continue;

    try {
      await db.executeQuery(
        'UPDATE queue SET position = $1 WHERE id = $2',
        [target, row.id]
      );
    } catch {
      // Ignore normalization failure and keep serving the queue using derived position.
    }
  }

  return rows.map((row) => ({
    ...row,
    position: Number(row.normalized_position || row.position || 0),
  }));
}

async function getQueueEntry(userId, bookId) {
  const rows = await normalizeQueuePositions(bookId);
  const found = rows.find((row) => String(row.user_id) === String(userId));
  return found || null;
}

async function getQueueCount(bookId) {
  const rows = await getQueueRowsByBook(bookId);
  return rows.length;
}

async function removeQueueEntry(userId, bookId) {
  await db.executeQuery(
    'DELETE FROM queue WHERE user_id = $1 AND book_id = $2',
    [userId, bookId]
  );
  return normalizeQueuePositions(bookId);
}

async function removeQueueEntryById(entryId, bookId) {
  await db.executeQuery('DELETE FROM queue WHERE id = $1', [entryId]);
  return normalizeQueuePositions(bookId);
}

function queueNotifiedAtMs(row) {
  const raw = row?.notified_at || null;
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function isQueueNotified(row) {
  const value = row?.notified;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return ['true', '1', 'yes'].includes(value.toLowerCase());
  return false;
}

function queueHoldExpired(row) {
  const notifiedAt = queueNotifiedAtMs(row);
  if (!notifiedAt) return false;
  return Date.now() - notifiedAt >= QUEUE_PICKUP_WINDOW_MS;
}

async function markQueueEntryNotified(entryId) {
  if (!entryId) return;

  try {
    await db.executeQuery(
      `UPDATE queue
       SET notified = true,
           notified_at = COALESCE(notified_at, CURRENT_TIMESTAMP)
       WHERE id = $1`,
      [entryId]
    );
  } catch {
    try {
      await db.executeQuery('UPDATE queue SET notified = true WHERE id = $1', [entryId]);
    } catch {
      // Some deployments may not have queue notification columns yet.
    }
  }
}

async function notifyQueueEntryAvailable(entry, bookId, bookTitle) {
  const nextUserId = String(entry?.user_id || '');
  if (!nextUserId) return null;

  await notifyUserAndSendEmail({
    userId: nextUserId,
    type: 'queue',
    title: 'Buku Tersedia Untukmu',
    body: `Buku "${bookTitle}" sudah tersedia dan sedang direservasi untukmu selama 3 hari. Segera pinjam sebelum antrean bergerak.`,
    bookId,
    emailSubject: 'Pustara - Buku yang Kamu Antrekan Sudah Tersedia',
  });

  await markQueueEntryNotified(entry.id);
  return {
    user_id: nextUserId,
    queue_position: Number(entry.position || entry.normalized_position || 1),
  };
}

async function expireQueueHold(entry, bookId, bookTitle) {
  const userId = String(entry?.user_id || '');
  if (!entry?.id || !userId) return;

  await removeQueueEntryById(entry.id, bookId);

  await notifyUserAndSendEmail({
    userId,
    type: 'queue',
    title: 'Reservasi Antrean Dibatalkan',
    body: `Reservasi antrean untuk buku "${bookTitle}" otomatis dibatalkan karena belum dipinjam dalam 3 hari.`,
    bookId,
    emailSubject: 'Pustara - Reservasi Antrean Buku Dibatalkan',
  }).catch((error) => {
    console.warn('[Shelf] Queue expiration notification warning:', error?.message || error);
  });
}

async function getBookQueueSnapshot(bookId) {
  const rows = toRows(
    await db.executeQuery(
      'SELECT id, title, COALESCE(available, 0) AS available FROM books WHERE id = $1 LIMIT 1',
      [bookId]
    )
  );
  return rows[0] || null;
}

async function reconcileAvailableQueueHold(bookId, providedTitle = null) {
  const book = await getBookQueueSnapshot(bookId);
  const available = Number(book?.available || 0);
  const bookTitle = String(providedTitle || book?.title || 'Buku');

  if (available <= 0) {
    return { book, queueRows: await normalizeQueuePositions(bookId), notifiedUser: null };
  }

  let notifiedUser = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const queueRows = await normalizeQueuePositions(bookId);
    const next = queueRows[0];
    if (!next) return { book, queueRows, notifiedUser };

    if (isQueueNotified(next)) {
      if (queueHoldExpired(next)) {
        await expireQueueHold(next, bookId, bookTitle);
        continue;
      }

      if (!queueNotifiedAtMs(next)) {
        await markQueueEntryNotified(next.id);
      }

      return { book, queueRows, notifiedUser };
    }

    notifiedUser = await notifyQueueEntryAvailable(next, bookId, bookTitle).catch((error) => {
      console.warn('[Shelf] Queue availability notification warning:', error?.message || error);
      return null;
    });
    if (!notifiedUser && next.id) {
      await markQueueEntryNotified(next.id);
    }

    return { book, queueRows: await normalizeQueuePositions(bookId), notifiedUser };
  }

  return { book, queueRows: await normalizeQueuePositions(bookId), notifiedUser };
}

async function getBooksWithAvailableQueuedCopies() {
  const rows = toRows(
    await db.executeQuery(
      `SELECT DISTINCT b.id, b.title
       FROM books b
       JOIN queue q ON q.book_id = b.id
       WHERE COALESCE(b.available, 0) > 0
         AND b.is_active = true`,
      []
    )
  );

  return rows.map((row) => ({
    id: String(row.id || ''),
    title: String(row.title || 'Buku'),
  })).filter((row) => row.id);
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

async function notifyNextQueuedUser(bookId, bookTitle) {
  const result = await reconcileAvailableQueueHold(bookId, bookTitle);
  if (result.notifiedUser) return result.notifiedUser;

  const next = result.queueRows?.[0];
  if (!next) return null;

  return {
    user_id: String(next.user_id || ''),
    queue_position: Number(next.position || next.normalized_position || 1),
  };
}

exports.getMyBookStatus = async (req, res) => {
  try {
    const actorUserId = await resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const { bookId } = req.params;
    await reconcileAvailableQueueHold(bookId);

    const [loan, wishlist, queueEntry, queueCount] = await Promise.all([
      getActiveLoan(actorUserId, bookId),
      getWishlistRow(actorUserId, bookId),
      getQueueEntry(actorUserId, bookId),
      getQueueCount(bookId),
    ]);

    const queuePosition = queueEntry
      ? Number(queueEntry.position || queueEntry.normalized_position || 0)
      : null;

    res.json({
      success: true,
      data: {
        borrowed: Boolean(loan),
        wishlisted: Boolean(wishlist),
        queued: Boolean(queueEntry),
        queue_position: queuePosition,
        queue_count: Number(queueCount || 0),
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

    await reconcileAvailableQueueHold(bookId, book.title);
    const existingQueueEntry = await getQueueEntry(actorUserId, bookId);

    if (available <= 0) {
      const queueCount = await getQueueCount(bookId);
      return res.status(409).json({
        success: false,
        message: 'Book is not available right now',
        data: {
          queued: Boolean(existingQueueEntry),
          queue_position: existingQueueEntry ? Number(existingQueueEntry.position || existingQueueEntry.normalized_position || 0) : null,
          queue_count: Number(queueCount || 0),
        },
      });
    }

    // ── Queue-priority enforcement ─────────────────────────────────────────
    // If there is an active queue for this book, only the person at position 1
    // may borrow. Everyone else (queued at position > 1, or not queued at all)
    // must wait for their turn.
    const queueCount = await getQueueCount(bookId);
    if (queueCount > 0) {
      const userQueuePosition = existingQueueEntry
        ? Number(existingQueueEntry.position || existingQueueEntry.normalized_position || 0)
        : null;

      if (!existingQueueEntry) {
        // User is not in queue at all — cannot bypass people who are waiting
        return res.status(409).json({
          success: false,
          message: 'Ada antrean aktif untuk buku ini. Silakan bergabung ke antrean terlebih dahulu.',
          data: {
            queued: false,
            queue_position: null,
            queue_count: queueCount,
          },
        });
      }

      if (userQueuePosition !== 1) {
        // User is in queue but not yet at the front
        return res.status(409).json({
          success: false,
          message: `Belum giliran kamu. Posisi antreanmu saat ini: ${userQueuePosition} dari ${queueCount}.`,
          data: {
            queued: true,
            queue_position: userQueuePosition,
            queue_count: queueCount,
          },
        });
      }
      // userQueuePosition === 1 → allowed to borrow, continue below
    }
    // ── end queue-priority enforcement ────────────────────────────────────

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
    await removeQueueEntry(actorUserId, bookId).catch(() => {
      // Queue cleanup should not block successful borrow.
    });

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
    const queueNotification = await notifyNextQueuedUser(activeLoan.book_id, returnedTitle).catch((error) => {
      console.warn('[Shelf] Queue notification warning:', error?.message || error);
      return null;
    });

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
        queue_notified_user_id: queueNotification?.user_id || null,
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
               SELECT progress_percentage, started_at, last_read_at, finished_at
               FROM reading_sessions
               WHERE book_id = l.book_id
                 AND user_id = l.user_id
                 AND status IN ('reading', 'active', 'paused', 'finished')
               ORDER BY COALESCE(finished_at, last_read_at, started_at) DESC NULLS LAST
               LIMIT 1
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
      // History items: returned loans only (no reading-only history before return)
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
                 WHEN COALESCE(l.due_date, l.due_at) IS NOT NULL
                  AND l.returned_at > COALESCE(l.due_date, l.due_at) THEN 'overdue'
                 WHEN rs.id IS NULL THEN 'unfinished'
                 WHEN COALESCE(rs.progress_percentage, 0) >= 100
                   OR (
                     COALESCE(rs.total_pages, 0) > 0
                     AND COALESCE(rs.current_page, 0) >= COALESCE(rs.total_pages, 0)
                   ) THEN 'finished'
                 ELSE 'unfinished'
               END AS history_status,
               l.returned_at AS history_at
             FROM loans l
             JOIN books b ON b.id = l.book_id
             LEFT JOIN LATERAL (
               SELECT id, current_page, total_pages, progress_percentage, finished_at, started_at, reading_time_minutes
               FROM reading_sessions
               WHERE book_id = l.book_id
                 AND user_id = l.user_id
                 AND started_at >= l.borrowed_at
                 AND started_at <= l.returned_at
               ORDER BY COALESCE(finished_at, last_read_at, started_at) DESC NULLS LAST
               LIMIT 1
             ) rs ON true
             WHERE l.user_id = $1
               AND b.is_active = true
               AND l.returned_at IS NOT NULL
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

    const seenHistoryLoanIds = new Set();
    const riwayat = historyRows
      .filter((row) => {
        const loanId = row.loan_id ? String(row.loan_id) : '';
        if (!loanId) return false;
        if (seenHistoryLoanIds.has(loanId)) return false;
        seenHistoryLoanIds.add(loanId);
        return true;
      })
      .map((row) => ({
        ...formatBook(row),
        loan_id: String(row.loan_id),
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
          ? calculateInclusiveDays(row.started_at, row.finished_at)
          : row.borrowed_at && row.returned_at
            ? calculateInclusiveDays(row.borrowed_at, row.returned_at)
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

exports.joinQueue = async (req, res) => {
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
    await reconcileAvailableQueueHold(bookId, book.title);
    const available = Number(book.available || 0);
    if (available > 0) {
      const queueCount = await getQueueCount(bookId);
      if (queueCount === 0) {
        return res.status(409).json({ success: false, message: 'Book is available right now. Borrow directly instead of queueing.' });
      }
    }

    const existingLoan = await getActiveLoan(actorUserId, bookId);
    if (existingLoan) {
      return res.status(409).json({ success: false, message: 'Book is already borrowed by this user' });
    }

    const existingQueueEntry = await getQueueEntry(actorUserId, bookId);
    if (existingQueueEntry) {
      const queueCount = await getQueueCount(bookId);
      return res.json({
        success: true,
        message: 'Already in queue',
        data: {
          queued: true,
          queue_position: Number(existingQueueEntry.position || existingQueueEntry.normalized_position || 0),
          queue_count: Number(queueCount || 0),
        },
      });
    }

    const queueRows = await normalizeQueuePositions(bookId);
    const nextPosition = queueRows.length + 1;

    await db.executeQuery(
      'INSERT INTO queue (user_id, book_id, position) VALUES ($1, $2, $3)',
      [actorUserId, bookId, nextPosition]
    );

    const updatedEntry = await getQueueEntry(actorUserId, bookId);
    const queueCount = await getQueueCount(bookId);

    try {
      await notifyUserAndSendEmail({
        userId: actorUserId,
        type: 'queue',
        title: 'Berhasil Masuk Antrean',
        body: `Kamu masuk antrean untuk buku "${book.title}". Posisi antreanmu saat ini: ${updatedEntry?.position || updatedEntry?.normalized_position || nextPosition}.`,
        bookId,
        emailSubject: 'Pustara - Konfirmasi Antrean Buku',
      });
    } catch (notificationError) {
      console.warn('Queue notification failed after successful join:', notificationError.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Successfully joined queue',
      data: {
        queued: true,
        queue_position: Number(updatedEntry?.position || updatedEntry?.normalized_position || nextPosition),
        queue_count: Number(queueCount || nextPosition),
      },
    });
  } catch (error) {
    const message = String(error?.message || 'Failed to join queue');

    if (message.toLowerCase().includes('duplicate') || message.toLowerCase().includes('unique')) {
      return res.status(409).json({ success: false, message: 'User is already in queue for this book' });
    }

    console.error('Error joining queue:', message);
    return res.status(500).json({ success: false, message: 'Failed to join queue', error: message });
  }
};

exports.leaveQueue = async (req, res) => {
  try {
    const actorUserId = await resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const { bookId } = req.params;
    const existingQueueEntry = await getQueueEntry(actorUserId, bookId);

    if (!existingQueueEntry) {
      return res.json({
        success: true,
        message: 'User was not in queue',
        data: {
          queued: false,
          queue_position: null,
          queue_count: await getQueueCount(bookId),
        },
      });
    }

    await removeQueueEntry(actorUserId, bookId);
    const queueCount = await getQueueCount(bookId);

    return res.json({
      success: true,
      message: 'Successfully left queue',
      data: {
        queued: false,
        queue_position: null,
        queue_count: Number(queueCount || 0),
      },
    });
  } catch (error) {
    console.error('Error leaving queue:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to leave queue', error: error.message });
  }
};

exports.expireStaleQueueReservations = async () => {
  const books = await getBooksWithAvailableQueuedCopies();
  let processed = 0;

  for (const book of books) {
    try {
      await reconcileAvailableQueueHold(book.id, book.title);
      processed += 1;
    } catch (error) {
      console.warn('[Shelf] Queue reservation reconciliation warning:', error?.message || error);
    }
  }

  return { processed };
};
