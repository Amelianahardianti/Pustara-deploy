const express = require('express');
const {
  getRecentReviews,
  getCommunityStats,
  toggleReviewLike,
  getReviewLikeStatus,
} = require('../controllers/reviewsController');

const router = express.Router();

/**
 * GET /reviews/recent  or  GET /community/recent
 * Public — latest community reviews (limit query param, max 50)
 */
router.get('/recent', getRecentReviews);

/**
 * GET /reviews  or  GET /community
 * Also expose top-level to match front-end fallback attempts.
 */
router.get('/', getRecentReviews);

/**
 * GET /reviews/stats  or  GET /community/stats
 * Real-time community stats: reader count, review count, positive %.
 */
router.get('/stats', getCommunityStats);

/**
 * POST /reviews/:id/like  or  POST /community/:id/like
 * Toggle like on a review. Auth required (returns 401 if unauthenticated —
 * optionalVerifyTokenMiddleware is set at mount level in index.js so req.user
 * is populated when a valid token is present; controller enforces auth itself).
 */
router.post('/:id/like', toggleReviewLike);

/**
 * GET /reviews/:id/like  or  GET /community/:id/like
 * Current user's like status + total likes for a review (optional auth).
 */
router.get('/:id/like', getReviewLikeStatus);

module.exports = router;
