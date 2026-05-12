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
const DASHBOARD_OVERVIEW_TTL_MS = 30 * 1000;

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

  // TODO: Implement user deletion service
  // For now, just return a message
  res.json({
    success: true,
    message: 'User deletion not yet implemented',
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
