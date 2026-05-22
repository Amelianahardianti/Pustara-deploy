/**
 * Analytics Routes
 * Provides API endpoints for statistics
 */

const express = require('express');
const router = express.Router();

const {
  getActiveUsers,
  getReadingTimeStats,
  getUserReadingHistory,
  getTopBooks,
  getPopularBooks,
} = require('../services/analyticsService');

/**
 * Stats Endpoints
 * All return JSON with statistics
 */

// GET /stats/active-users?hours=24
// Returns: active user count, books being read, avg progress
router.get('/active-users', async (req, res) => {
  try {
    const { hours = 24 } = req.query;
    const stats = await getActiveUsers(parseInt(hours));

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error('Error fetching active users:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch active users' });
  }
});

// GET /stats/reading-time?period=week
// period: 'today' | 'week' | 'month' | 'all'
// Returns: total minutes, avg per session, sessions count, unique readers
router.get('/reading-time', async (req, res) => {
  try {
    const { period = 'week' } = req.query;
    const stats = await getReadingTimeStats(period);

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error('Error fetching reading time stats:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch reading time stats' });
  }
});

// GET /stats/top-books?limit=10
// Returns: list of most-read books with reader count & avg progress
router.get('/top-books', async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    const books = await getTopBooks(parseInt(limit));

    res.json({
      success: true,
      data: books,
    });
  } catch (error) {
    console.error('Error fetching top books:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch top books' });
  }
});

// GET /stats/popular-books?limit=40
// Returns: list of popular books ranked by rating, readers, borrow activity, and recency
router.get('/popular-books', async (req, res) => {
  try {
    const { limit = 40 } = req.query;
    const books = await getPopularBooks(parseInt(limit, 10));

    res.json({
      success: true,
      data: books,
    });
  } catch (error) {
    console.error('Error fetching popular books:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch popular books' });
  }
});

// GET /stats/dashboard
// Combine all stats for dashboard view
router.get('/dashboard', async (req, res) => {
  try {
    const activeUsers = await getActiveUsers(24);
    const readingTime = await getReadingTimeStats('week');
    const topBooks = await getTopBooks(5);

    res.json({
      success: true,
      data: {
        active_users_24h: activeUsers.active_users,
        books_being_read: activeUsers.books_being_read,
        reading_this_week: readingTime,
        top_books: topBooks,
      },
    });
  } catch (error) {
    console.error('Error fetching dashboard data:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch dashboard data' });
  }
});

module.exports = router;
