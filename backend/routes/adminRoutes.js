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

module.exports = router;
