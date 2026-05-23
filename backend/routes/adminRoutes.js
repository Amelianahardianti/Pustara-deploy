/**
 * Admin Routes
 * Protected by verifyToken + authorizeAdmin middleware
 * 
 * Handles:
 * - GET /admin/users - List all users
 * - PUT /admin/users/:uid/role - Update user role
 * - DELETE /admin/users/:uid - Delete user
 * - GET /admin/users/:uid - Get user details
 */

const express = require('express');
const router = express.Router();
const UserService = require('../services/userService');
const { getAdminDashboardAnalytics } = require('../services/analyticsService');
const FirebaseProvider = require('../providers/firebaseProvider');
const DASHBOARD_OVERVIEW_TTL_MS = 30 * 1000;
const firebaseProvider = new FirebaseProvider();

let dashboardOverviewCache = null;

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch((err) => {
    console.error(`Admin route error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Internal server error' });
  });
};

/**
 * GET /admin/users - Get all users with pagination
 */
router.get('/users', asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || 50), 1), 500);
  const offset = Math.max(parseInt(req.query.offset || 0), 0);

  const result = await UserService.getAllUsers(limit, offset);
  if (!result.success) {
    return res.status(500).json({ success: false, error: result.error });
  }

  res.json({
    success: true,
    data: result.data,
    pagination: {
      limit,
      offset,
      total: result.total,
    },
  });
}));

/**
 * GET /admin/users/:uid - Get user details by UID
 */
router.get('/users/:uid', asyncHandler(async (req, res) => {
  const { uid } = req.params;
  
  const result = await UserService.getUserByUid(uid);
  if (!result.success || !result.data) {
    return res.status(404).json({ success: false, error: 'User not found' });
  }

  res.json({
    success: true,
    data: result.data,
  });
}));

/**
 * PUT /admin/users/:uid - Update admin-managed user fields
 * Body: { role?, status? }
 */
router.put('/users/:uid', asyncHandler(async (req, res) => {
  const { uid } = req.params;
  const hasProfileFields = ['display_name', 'username', 'avatar_url'].some((field) => typeof req.body?.[field] === 'string');
  if (hasProfileFields) {
    return res.status(400).json({
      success: false,
      error: 'Admin hanya boleh mengubah role dan status. Nama tampilan, username, dan avatar hanya bisa diubah oleh pengguna sendiri.',
    });
  }

  const updates = {};
  if (typeof req.body?.role === 'string' && ['reader', 'admin'].includes(req.body.role)) {
    updates.role = req.body.role;
  }
  if (typeof req.body?.status === 'string' && ['active', 'suspended'].includes(req.body.status)) {
    updates.status = req.body.status;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({
      success: false,
      error: 'No valid admin fields to update',
    });
  }

  const results = [];
  if (updates.role) {
    results.push(await UserService.updateUserRole(uid, updates.role));
  }
  if (updates.status) {
    results.push(await UserService.updateUserStatus(uid, updates.status));
  }

  const failed = results.find((result) => !result.success);
  if (failed) {
    return res.status(500).json({ success: false, error: failed.error });
  }

  const latest = results[results.length - 1] || null;
  res.json({
    success: true,
    message: 'User admin fields updated successfully',
    data: latest?.data || null,
  });
}));

/**
 * PUT /admin/users/:uid/role - Update user role
 * Body: { role: 'admin' | 'reader' }
 */
router.put('/users/:uid/role', asyncHandler(async (req, res) => {
  const { uid } = req.params;
  const { role } = req.body;

  if (!role || !['reader', 'admin'].includes(role)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid role. Must be "reader" or "admin"',
    });
  }

  // Prevent admin from downgrading themselves
  if (req.user?.uid === uid && role === 'reader') {
    return res.status(403).json({
      success: false,
      error: 'Cannot downgrade your own admin role',
    });
  }

  const result = await UserService.updateUserRole(uid, role);
  if (!result.success) {
    return res.status(500).json({ success: false, error: result.error });
  }

  res.json({
    success: true,
    message: `User role updated to ${role}`,
    data: result.data,
  });
}));

/**
 * PUT /admin/users/:uid/status - Update user status
 * Body: { status: 'active' | 'suspended' }
 */
router.put('/users/:uid/status', asyncHandler(async (req, res) => {
  const { uid } = req.params;
  const { status } = req.body;

  if (!status || !['active', 'suspended'].includes(status)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid status. Must be "active" or "suspended"',
    });
  }

  if (req.user?.uid === uid && status === 'suspended') {
    return res.status(403).json({
      success: false,
      error: 'Cannot suspend your own account',
    });
  }

  const result = await UserService.updateUserStatus(uid, status);
  if (!result.success) {
    return res.status(500).json({ success: false, error: result.error });
  }

  res.json({
    success: true,
    message: `User status updated to ${status}`,
    data: result.data,
  });
}));

/**
 * DELETE /admin/users/:uid - Delete user
 */
router.delete('/users/:uid', asyncHandler(async (req, res) => {
  const { uid } = req.params;

  // Prevent admin from deleting themselves
  if (req.user?.uid === uid) {
    return res.status(403).json({
      success: false,
      error: 'Cannot delete your own account',
    });
  }

  const userResult = await UserService.getUserByUid(uid);
  if (!userResult.success || !userResult.data) {
    return res.status(404).json({
      success: false,
      error: 'User not found',
    });
  }

  const firebaseDeletion = await firebaseProvider.deleteUser(uid);
  if (!firebaseDeletion.success) {
    return res.status(500).json({ success: false, error: firebaseDeletion.error });
  }

  const result = await UserService.deleteUserByUid(uid);
  if (!result.success) {
    return res.status(500).json({ success: false, error: result.error });
  }

  res.json({
    success: true,
    message: 'User deleted successfully',
  });
}));

/**
 * GET /admin/dashboard/overview - Aggregated dashboard analytics for admin FE
 */
router.get('/dashboard/overview', asyncHandler(async (_req, res) => {
  const now = Date.now();
  if (dashboardOverviewCache && dashboardOverviewCache.expiresAt > now) {
    return res.json({
      success: true,
      data: dashboardOverviewCache.data,
      cached: true,
    });
  }

  const data = await getAdminDashboardAnalytics();
  dashboardOverviewCache = {
    data,
    expiresAt: now + DASHBOARD_OVERVIEW_TTL_MS,
  };

  res.json({
    success: true,
    data,
    cached: false,
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// LOANS MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

const db = require('../config/database');

function toRows(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.rows)) return result.rows;
  if (result && Array.isArray(result.recordset)) return result.recordset;
  return [];
}

/**
 * GET /admin/loans
 * Query: status (active|returned|overdue|all), search, limit, offset
 */
router.get('/loans', asyncHandler(async (req, res) => {
  const limit  = Math.min(Math.max(parseInt(req.query.limit  || 50),  1), 200);
  const offset = Math.max(parseInt(req.query.offset || 0), 0);
  const status = req.query.status || 'all';   // 'active' | 'returned' | 'overdue' | 'all'
  const search = req.query.search ? `%${req.query.search}%` : null;

  const conditions = [];
  const params = [];

  if (status === 'active')   { conditions.push(`l.returned_at IS NULL AND (l.status IS NULL OR l.status = 'active') AND COALESCE(l.due_at, l.due_date) >= NOW()`); }
  if (status === 'overdue')  { conditions.push(`l.returned_at IS NULL AND COALESCE(l.due_at, l.due_date) < NOW()`); }
  if (status === 'returned') { conditions.push(`l.returned_at IS NOT NULL`); }

  if (search) {
    params.push(search);
    conditions.push(`(LOWER(b.title) ILIKE $${params.length} OR LOWER(u.email) ILIKE $${params.length} OR LOWER(COALESCE(u.display_name, u.username)) ILIKE $${params.length})`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countQuery = `
    SELECT COUNT(DISTINCT l.id) AS total
    FROM loans l
    JOIN books b ON b.id = l.book_id
    JOIN users u ON u.id = l.user_id
    ${whereClause}
  `;

  params.push(limit, offset);

  const dataQuery = `
    WITH latest_sessions AS (
      SELECT DISTINCT ON (user_id, book_id)
        user_id,
        book_id,
        progress_percentage,
        current_page,
        total_pages
      FROM reading_sessions
      ORDER BY user_id, book_id, COALESCE(last_read_at, finished_at, started_at) DESC NULLS LAST, id DESC
    )
    SELECT DISTINCT ON (l.id)
      l.id             AS loan_id,
      l.borrowed_at,
      COALESCE(l.due_date, l.due_at) AS due_at,
      l.returned_at,
      l.extended,
      COALESCE(l.status, CASE
        WHEN l.returned_at IS NOT NULL THEN 'returned'
        WHEN COALESCE(l.due_date, l.due_at) < NOW() THEN 'overdue'
        ELSE 'active'
      END) AS status,
      CASE
        WHEN l.returned_at IS NOT NULL THEN NULL
        ELSE EXTRACT(DAY FROM (COALESCE(l.due_date, l.due_at) - NOW()))::int
      END AS days_left,
      b.id         AS book_id,
      b.title      AS book_title,
      b.authors    AS book_authors,
      b.genres     AS book_genres,
      b.cover_url  AS book_cover_url,
      u.id         AS user_id,
      u.firebase_uid,
      u.email      AS user_email,
      COALESCE(u.display_name, u.username, u.email) AS user_name,
      u.avatar_url AS user_avatar,
      rs.progress_percentage,
      rs.current_page,
      rs.total_pages
    FROM loans l
    JOIN books b ON b.id = l.book_id
    JOIN users u ON u.id = l.user_id
    LEFT JOIN latest_sessions rs ON rs.user_id = l.user_id AND rs.book_id = l.book_id
    ${whereClause}
    ORDER BY l.id, l.borrowed_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `;

  const [countResult, dataResult] = await Promise.all([
    db.executeQuery(countQuery, params.slice(0, params.length - 2)),
    db.executeQuery(dataQuery, params),
  ]);

  const countRows = toRows(countResult);
  const total = Number(countRows[0]?.total ?? 0);

  res.json({
    success: true,
    data: toRows(dataResult),
    pagination: { limit, offset, total },
  });
}));

/**
 * GET /admin/loans/stats
 * Aggregate stats for the dashboard card
 */
router.get('/loans/stats', asyncHandler(async (_req, res) => {
  const result = await db.executeQuery(`
    SELECT
      COUNT(*) FILTER (WHERE returned_at IS NULL AND COALESCE(due_date, due_at) >= NOW()) AS active,
      COUNT(*) FILTER (WHERE returned_at IS NULL AND COALESCE(due_date, due_at) < NOW())  AS overdue,
      COUNT(*) FILTER (WHERE returned_at IS NOT NULL) AS returned,
      COUNT(*) FILTER (WHERE extended = true) AS extended,
      COUNT(*) FILTER (WHERE borrowed_at >= NOW() - INTERVAL '7 days') AS new_this_week
    FROM loans
  `);
  const rows = toRows(result);
  res.json({ success: true, data: rows[0] || {} });
}));

/**
 * GET /admin/loans/by-book/:bookId
 * All loans for a specific book — for the "per-book" drilldown
 */
router.get('/loans/by-book/:bookId', asyncHandler(async (req, res) => {
  const { bookId } = req.params;
  const result = await db.executeQuery(`
    WITH latest_sessions AS (
      SELECT DISTINCT ON (user_id, book_id)
        user_id,
        book_id,
        progress_percentage,
        current_page,
        total_pages
      FROM reading_sessions
      ORDER BY user_id, book_id, COALESCE(last_read_at, finished_at, started_at) DESC NULLS LAST, id DESC
    )
    SELECT DISTINCT ON (l.id)
      l.id AS loan_id,
      l.borrowed_at,
      COALESCE(l.due_date, l.due_at) AS due_at,
      l.returned_at,
      l.extended,
      COALESCE(l.status, CASE
        WHEN l.returned_at IS NOT NULL THEN 'returned'
        WHEN COALESCE(l.due_date, l.due_at) < NOW() THEN 'overdue'
        ELSE 'active'
      END) AS status,
      CASE
        WHEN l.returned_at IS NOT NULL THEN NULL
        ELSE EXTRACT(DAY FROM (COALESCE(l.due_date, l.due_at) - NOW()))::int
      END AS days_left,
      u.id         AS user_id,
      u.email      AS user_email,
      COALESCE(u.display_name, u.username, u.email) AS user_name,
      u.avatar_url AS user_avatar,
      rs.progress_percentage,
      rs.current_page,
      rs.total_pages
    FROM loans l
    JOIN users u ON u.id = l.user_id
    LEFT JOIN latest_sessions rs ON rs.user_id = l.user_id AND rs.book_id = l.book_id
    WHERE l.book_id = $1
    ORDER BY l.id, l.borrowed_at DESC
  `, [bookId]);

  res.json({ success: true, data: toRows(result) });
}));

/**
 * PUT /admin/loans/:loanId/return
 * Force-return a loan as admin
 */
router.put('/loans/:loanId/return', asyncHandler(async (req, res) => {
  const { loanId } = req.params;

  const loanRows = toRows(await db.executeQuery(
    `SELECT id, user_id, book_id, returned_at FROM loans WHERE id = $1`, [loanId]
  ));

  if (!loanRows.length) return res.status(404).json({ success: false, error: 'Loan not found' });
  if (loanRows[0].returned_at) return res.status(400).json({ success: false, error: 'Loan already returned' });

  const { book_id } = loanRows[0];

  await db.executeQuery(
    `UPDATE loans SET returned_at = NOW(), status = 'returned' WHERE id = $1`, [loanId]
  );

  await db.executeQuery(
    `UPDATE books SET available = available + 1 WHERE id = $1`, [book_id]
  );

  res.json({ success: true, message: 'Loan force-returned by admin' });
}));

// ─────────────────────────────────────────────────────────────────────────────
// REVIEWS MODERATION (contents-management)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /admin/reviews
 * All reviews with user + book info
 * Query: limit, offset, rating (1-5 or 'all'), search
 */
router.get('/reviews', asyncHandler(async (req, res) => {
  const limit  = Math.min(Math.max(parseInt(req.query.limit  || 30), 1), 100);
  const offset = Math.max(parseInt(req.query.offset || 0), 0);
  const rating = parseInt(req.query.rating) || null;
  const search = req.query.search ? `%${req.query.search}%` : null;

  const conditions = ['(b.is_active IS NULL OR b.is_active = true)'];
  const params = [];

  if (rating && rating >= 1 && rating <= 5) {
    params.push(rating);
    conditions.push(`r.rating = $${params.length}`);
  }
  if (search) {
    params.push(search);
    conditions.push(`(LOWER(b.title) ILIKE $${params.length} OR LOWER(COALESCE(u.display_name, u.username)) ILIKE $${params.length})`);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM reviews r
    JOIN books b ON b.id = r.book_id
    LEFT JOIN users u ON u.id = r.user_id
    ${whereClause}
  `;

  params.push(limit, offset);

  const dataQuery = `
    SELECT
      r.id           AS review_id,
      r.rating,
      COALESCE(r.review_text, r.body, r.text, '') AS review_text,
      r.likes,
      COALESCE(r.created_at, r.created_at_utc) AS created_at,
      b.id           AS book_id,
      b.title        AS book_title,
      b.cover_url    AS book_cover_url,
      b.authors      AS book_authors,
      u.id           AS user_id,
      u.email        AS user_email,
      COALESCE(u.display_name, u.username, u.email) AS user_name,
      u.avatar_url   AS user_avatar
    FROM reviews r
    JOIN books b ON b.id = r.book_id
    LEFT JOIN users u ON u.id = r.user_id
    ${whereClause}
    ORDER BY COALESCE(r.created_at, r.created_at_utc) DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `;

  const [countResult, dataResult] = await Promise.all([
    db.executeQuery(countQuery, params.slice(0, params.length - 2)),
    db.executeQuery(dataQuery, params),
  ]);

  const countRows = toRows(countResult);
  res.json({
    success: true,
    data: toRows(dataResult),
    pagination: { limit, offset, total: Number(countRows[0]?.total ?? 0) },
  });
}));

/**
 * DELETE /admin/reviews/:reviewId
 * Admin delete a review
 */
router.delete('/reviews/:reviewId', asyncHandler(async (req, res) => {
  const { reviewId } = req.params;

  const rows = toRows(await db.executeQuery('SELECT id, book_id FROM reviews WHERE id = $1', [reviewId]));
  if (!rows.length) return res.status(404).json({ success: false, error: 'Review not found' });

  await db.executeQuery('DELETE FROM reviews WHERE id = $1', [reviewId]);

  await db.executeQuery(`
    UPDATE books
    SET avg_rating   = (SELECT ROUND(AVG(rating)::numeric, 2) FROM reviews WHERE book_id = $1),
        rating_count = (SELECT COUNT(*) FROM reviews WHERE book_id = $1)
    WHERE id = $1
  `, [rows[0].book_id]);

  res.json({ success: true, message: 'Review deleted' });
}));

// ─── BROADCAST NOTIFICATION ───────────────────────────────────────────────────

/**
 * POST /admin/broadcast
 * Send in-app notification to all active users
 * Body: { title, body, type }
 */
router.post('/broadcast', asyncHandler(async (req, res) => {
  const { title, body, type = 'system' } = req.body;
  if (!title?.trim()) return res.status(400).json({ success: false, error: 'Judul wajib diisi' });
  if (!body?.trim())  return res.status(400).json({ success: false, error: 'Isi pesan wajib diisi' });

  const { insertNotification } = require('../services/notificationService');

  const usersResult = await db.executeQuery(
    `SELECT id FROM users WHERE status = 'active' OR status IS NULL LIMIT 2000`,
    []
  );
  const users = toRows(usersResult);

  let sent = 0;
  for (const user of users) {
    try {
      await insertNotification({
        userId: String(user.id),
        type,
        title: title.trim(),
        body: body.trim(),
      });
      sent++;
    } catch (e) {
      console.warn(`[broadcast] notif failed user ${user.id}:`, e.message);
    }
  }

  res.json({ success: true, message: `Broadcast terkirim ke ${sent} pengguna`, sent });
}));

// ─── ADUAN / REPORTS ──────────────────────────────────────────────────────────

/**
 * GET /admin/reports
 * Returns pending review reports
 */
router.get('/reports', asyncHandler(async (_req, res) => {
  try {
    const result = await db.executeQuery(`
      SELECT
        rr.id            AS report_id,
        rr.reason,
        rr.created_at    AS reported_at,
        r.id             AS review_id,
        COALESCE(r.review_text, r.body, r.text, '') AS review_text,
        r.rating,
        b.id             AS book_id,
        b.title          AS book_title,
        COALESCE(ua.display_name, ua.username, ua.email) AS reviewer_name,
        COALESCE(ur.display_name, ur.username, ur.email) AS reporter_name
      FROM review_reports rr
      JOIN reviews r  ON r.id  = rr.review_id
      JOIN books   b  ON b.id  = r.book_id
      LEFT JOIN users ua ON ua.id = r.user_id
      LEFT JOIN users ur ON ur.id = rr.reporter_id
      WHERE rr.status = 'pending'
      ORDER BY rr.created_at DESC
      LIMIT 100
    `, []);
    res.json({ success: true, data: toRows(result) });
  } catch (_) {
    // table belum ada → return kosong, jangan crash
    res.json({ success: true, data: [] });
  }
}));

/**
 * PUT /admin/reports/:reportId/dismiss
 * Mark report as dismissed (keep the review)
 */
router.put('/reports/:reportId/dismiss', asyncHandler(async (req, res) => {
  const { reportId } = req.params;
  try {
    await db.executeQuery(
      `UPDATE review_reports SET status = 'dismissed', resolved_at = NOW() WHERE id = $1`,
      [reportId]
    );
  } catch (_) { /* table mungkin belum ada */ }
  res.json({ success: true, message: 'Laporan diabaikan' });
}));

/**
 * DELETE /admin/reports/:reportId
 * Delete the review + resolve the report
 */
router.delete('/reports/:reportId', asyncHandler(async (req, res) => {
  const { reportId } = req.params;

  let reviewId = null;
  let bookId   = null;

  try {
    const reportRows = toRows(await db.executeQuery(
      `SELECT review_id FROM review_reports WHERE id = $1`, [reportId]
    ));
    if (reportRows.length) {
      reviewId = reportRows[0].review_id;
      const reviewRows = toRows(await db.executeQuery('SELECT book_id FROM reviews WHERE id = $1', [reviewId]));
      if (reviewRows.length) bookId = reviewRows[0].book_id;
    }
  } catch (_) { /* table mungkin belum ada */ }

  if (reviewId) {
    await db.executeQuery('DELETE FROM reviews WHERE id = $1', [reviewId]);
    if (bookId) {
      await db.executeQuery(`
        UPDATE books
        SET avg_rating   = (SELECT ROUND(AVG(rating)::numeric, 2) FROM reviews WHERE book_id = $1),
            rating_count = (SELECT COUNT(*) FROM reviews WHERE book_id = $1)
        WHERE id = $1
      `, [bookId]);
    }
  }

  try {
    await db.executeQuery(
      `UPDATE review_reports SET status = 'resolved', resolved_at = NOW() WHERE id = $1`, [reportId]
    );
  } catch (_) { /* table mungkin belum ada */ }

  res.json({ success: true, message: 'Ulasan dihapus dan laporan diselesaikan' });
}));

module.exports = router;
