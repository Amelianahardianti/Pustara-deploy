// Books Routes dengan file handling
const express = require('express');
const router = express.Router();
const booksController = require('../controllers/booksController');

// PUBLIC ROUTES - Read only
router.get('/books', booksController.getBooks);
router.get('/books/genres', booksController.getGenres);
router.get('/books/search', booksController.searchBooks);
router.get('/books/:id/similar', booksController.getSimilarBooks);
router.get('/books/:id', booksController.getBookDetail);
router.get('/books/:id/access', booksController.getBookReadAccess);
router.get('/books/:id/file', booksController.downloadBookFile);
router.get('/books/:id/reviews', booksController.getBookReviews);
router.post('/reviews', booksController.createOrUpdateReview);

// Admin routes will be mounted separately with auth middleware in index.js
// router.post('/books', authorizeAdmin, booksController.createBook);
// router.put('/books/:id', authorizeAdmin, booksController.updateBook);
// router.delete('/books/:id', authorizeAdmin, booksController.deleteBook);

module.exports = router;
