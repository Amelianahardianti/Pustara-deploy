/**
 * Shelf Routes
 * API endpoints for user shelf management (loans, reading sessions, wishlist)
 */

const express = require('express');
const shelfController = require('../controllers/shelfController');

const router = express.Router();

/**
 * GET /shelf/me
 * Returns all shelf data: pinjaman, dibaca, riwayat, wishlist
 * Requires authentication
 */
router.get('/me', shelfController.getMyShelf);
router.get('/me/status/:bookId', shelfController.getMyBookStatus);
router.post('/me/borrow/:bookId', shelfController.borrowBook);
router.post('/me/return/:loanOrBookId', shelfController.returnBook);
router.post('/me/return-book/:bookId', shelfController.returnBook);
router.post('/me/extend/:loanId', shelfController.extendLoan);
router.post('/me/wishlist/:bookId', shelfController.addToWishlist);
router.delete('/me/wishlist/:bookId', shelfController.removeFromWishlist);

module.exports = router;
