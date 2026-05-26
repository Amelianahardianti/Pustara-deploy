/**
 * Feed Routes
 * API endpoints for user feed (activity, notifications, recommendations)
 */

const express = require('express');
const {
  getMyFeedActivity,
  getMyNotifications,
  markMyNotificationsRead,
  deleteMyNotification,
  getMyRecommendations,
} = require('../controllers/feedController');

const router = express.Router();

/**
 * GET /feed/me/activity
 * Returns user's reading activity (current reads + finished reads)
 * Requires authentication
 */
router.get('/me/activity', getMyFeedActivity);

/**
 * GET /feed/me/notifications
 * Returns user's notifications
 * Requires authentication
 */
router.get('/me/notifications', getMyNotifications);
router.patch('/me/notifications/read', markMyNotificationsRead);
router.patch('/me/notifications/:notificationId/read', markMyNotificationsRead);
router.delete('/me/notifications/:notificationId', deleteMyNotification);

/**
 * GET /feed/me/recommendations
 * Returns personalized recommendations for feed sidebar
 * Requires authentication
 */
router.get('/me/recommendations', getMyRecommendations);

module.exports = router;
