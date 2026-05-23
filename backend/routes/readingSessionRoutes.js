/**
 * Reading Session Routes
 * API endpoints for reading session management
 */

const express = require('express');
const router = express.Router();

const {
  startReadingSession,
  updateReadingProgress,
  finishReadingSession,
  updateReadingProgressByBook,
  finishReadingByBook,
  pauseReadingByBook,
  getUserSessions,
  getSessionDetails,
} = require('../controllers/readingSessionController');

// Middleware (akan dijalankan di index.js, tapi import di sini untuk referensi)
// - verifyToken: Validates Firebase token and sets req.user

/**
 * Reading Session Endpoints
 * 
 * All endpoints require authentication (Firebase token in Authorization header)
 */

// Start a new reading session
// POST /reading/start/:bookId
// Body: { total_pages? }
router.post('/start/:bookId', startReadingSession);

// Get all reading sessions for current user
// GET /reading/sessions?status=reading&limit=10&offset=0
router.get('/sessions', getUserSessions);

// Get specific session details
// GET /reading/:sessionId
router.get('/:sessionId', getSessionDetails);

// Update reading progress
// PUT /reading/update/:sessionId
// Body: { current_page?, reading_time_minutes?, status? }
router.put('/update/:sessionId', updateReadingProgress);

// Book-based update reading progress for the current frontend contract
// POST /reading/update
// Body: { bookId, currentPage?, readingTimeMinutes?, status? }
router.post('/update', updateReadingProgressByBook);

// Finish a reading session
// POST /reading/finish/:sessionId
router.post('/finish/:sessionId', finishReadingSession);

// Book-based finish reading endpoint
router.post('/finish', finishReadingByBook);

// Book-based pause reading endpoint
router.post('/pause', pauseReadingByBook);

module.exports = router;
