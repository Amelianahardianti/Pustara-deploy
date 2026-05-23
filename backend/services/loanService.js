/**
 * Loan Service
 * Smart lending logic: 7-day loan, auto-drop, extensions, status tracking
 */

const db = require('../config/database');

const LOAN_DURATION_DAYS = 7;
const EXTENSION_DAYS = 3;
const MAX_EXTENSIONS = 1;

/**
 * Borrow a book
 * Returns: { success, data: loan, message }
 */
exports.borrowBook = async (userId, bookId) => {
  try {
    const pool = require('../config/database').getPool();

    // Check if book exists
    const bookResult = await pool.query(
      'SELECT id, total_stock, available FROM books WHERE id = $1 AND is_active = true',
      [bookId]
    );

    if (bookResult.rows.length === 0) {
      return { success: false, message: 'Buku tidak ditemukan' };
    }

    const book = bookResult.rows[0];
    if (Number(book.available) <= 0) {
      return { success: false, message: 'Buku tidak tersedia untuk dipinjam' };
    }

    // Check if user already borrowed this book (active loan)
    const existingLoan = await pool.query(
      `SELECT id FROM loans 
       WHERE user_id = $1 AND book_id = $2 AND status IN ('active', 'extended')`,
      [userId, bookId]
    );

    if (existingLoan.rows.length > 0) {
      return { success: false, message: 'Anda sudah meminjam buku ini' };
    }

    // Create loan with 7-day deadline
    const borrowedAt = new Date();
    const dueAt = new Date();
    dueAt.setDate(dueAt.getDate() + LOAN_DURATION_DAYS);

    const loanResult = await pool.query(
      `INSERT INTO loans (user_id, book_id, borrowed_at, due_at, status)
       VALUES ($1, $2, $3, $4, 'active')
       RETURNING *`,
      [userId, bookId, borrowedAt, dueAt]
    );

    // Decrease available count
    await pool.query(
      'UPDATE books SET available = available - 1 WHERE id = $1',
      [bookId]
    );

    return {
      success: true,
      data: loanResult.rows[0],
      message: `Berhasil meminjam buku. Harus dikembalikan dalam ${LOAN_DURATION_DAYS} hari`,
    };
  } catch (error) {
    console.error('Error borrowing book:', error.message);
    return { success: false, message: error.message };
  }
};

/**
 * Return a borrowed book
 */
exports.returnBook = async (userId, loanId) => {
  try {
    const pool = require('../config/database').getPool();

    const loanResult = await pool.query(
      'SELECT id, book_id, status FROM loans WHERE id = $1 AND user_id = $2',
      [loanId, userId]
    );

    if (loanResult.rows.length === 0) {
      return { success: false, message: 'Pinjaman tidak ditemukan' };
    }

    const loan = loanResult.rows[0];

    // Update loan status
    const returnedAt = new Date();
    await pool.query(
      `UPDATE loans SET returned_at = $1, status = 'returned'
       WHERE id = $2`,
      [returnedAt, loanId]
    );

    // Increase available count
    await pool.query(
      'UPDATE books SET available = available + 1 WHERE id = $1',
      [loan.book_id]
    );

    return {
      success: true,
      message: 'Buku berhasil dikembalikan',
    };
  } catch (error) {
    console.error('Error returning book:', error.message);
    return { success: false, message: error.message };
  }
};

/**
 * Extend loan (add 3 more days) - only 1 extension allowed
 */
exports.extendLoan = async (userId, loanId) => {
  try {
    const pool = require('../config/database').getPool();

    const loanResult = await pool.query(
      'SELECT id, extended, due_at, status FROM loans WHERE id = $1 AND user_id = $2',
      [loanId, userId]
    );

    if (loanResult.rows.length === 0) {
      return { success: false, message: 'Pinjaman tidak ditemukan' };
    }

    const loan = loanResult.rows[0];

    // Check if already extended
    if (loan.extended) {
      return { success: false, message: 'Pinjaman sudah pernah diperpanjang' };
    }

    // Check if not overdue
    if (loan.status === 'overdue') {
      return { success: false, message: 'Pinjaman sudah terlambat, tidak bisa diperpanjang' };
    }

    // Calculate new due date
    const newDueAt = new Date(loan.due_at);
    newDueAt.setDate(newDueAt.getDate() + EXTENSION_DAYS);

    // Update loan
    await pool.query(
      `UPDATE loans 
       SET due_at = $1, extended = true, status = 'extended'
       WHERE id = $2`,
      [newDueAt, loanId]
    );

    return {
      success: true,
      message: `Peminjaman diperpanjang ${EXTENSION_DAYS} hari tambahan. Due date: ${newDueAt.toLocaleDateString('id-ID')}`,
    };
  } catch (error) {
    console.error('Error extending loan:', error.message);
    return { success: false, message: error.message };
  }
};

/**
 * Auto-drop overdue loans (call periodically via cron job)
 * Moves books back to available
 */
exports.autoDropOverdueLoans = async () => {
  try {
    const pool = require('../config/database').getPool();

    const now = new Date();

    // Find overdue loans that haven't been returned
    const overdueResult = await pool.query(
      `SELECT id, book_id FROM loans 
       WHERE status IN ('active', 'extended') 
       AND due_at < $1 
       AND returned_at IS NULL`,
      [now]
    );

    const overdueLoans = overdueResult.rows;

    for (const loan of overdueLoans) {
      // Mark as overdue
      await pool.query(
        `UPDATE loans SET status = 'overdue' WHERE id = $1`,
        [loan.id]
      );

      // Restore available count
      await pool.query(
        'UPDATE books SET available = available + 1 WHERE id = $1',
        [loan.book_id]
      );

      console.log(`✅ Auto-dropped overdue loan: ${loan.id}`);
    }

    return { dropped: overdueLoans.length };
  } catch (error) {
    console.error('Error auto-dropping overdue loans:', error.message);
    return { dropped: 0, error: error.message };
  }
};

/**
 * Get loan details dengan status dan days left
 */
exports.getLoanWithStatus = async (loanId) => {
  try {
    const pool = require('../config/database').getPool();

    const result = await pool.query(
      `SELECT 
         l.*,
         b.title, b.authors, b.cover_id, b.isbn
       FROM loans l
       JOIN books b ON l.book_id = b.id
       WHERE l.id = $1`,
      [loanId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const loan = result.rows[0];
    const now = new Date();
    const daysLeft = Math.ceil((new Date(loan.due_at) - now) / (1000 * 60 * 60 * 24));

    return {
      ...loan,
      daysLeft: Math.max(0, daysLeft),
      isOverdue: daysLeft < 0,
      canExtend: !loan.extended && loan.status !== 'overdue' && loan.status !== 'returned',
    };
  } catch (error) {
    console.error('Error getting loan with status:', error.message);
    return null;
  }
};

/**
 * Calculate penalty for overdue books (optional)
 * Anda bisa adjust logic ini sesuai kebijakan
 */
exports.calculatePenalty = (daysOverdue) => {
  const PENALTY_PER_DAY = 1000; // Rp 1000 per hari
  return Math.max(0, daysOverdue) * PENALTY_PER_DAY;
};
