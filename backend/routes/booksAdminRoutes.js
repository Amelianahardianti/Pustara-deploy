// Admin Books Routes
// Protected by verifyToken + authorizeAdmin middleware
const express = require('express');
const router = express.Router();
const booksController = require('../controllers/booksController');

// Admin CRUD Routes - These will have auth middleware applied in index.js
// router.get('/books/without-file', booksController.getBooksWithoutFile);
// router.post('/books', booksController.createBook);
// router.put('/books/:id', booksController.updateBook);
// router.delete('/books/:id', booksController.deleteBook);

// routes/booksAdminRoutes.js

router.get('/', booksController.getBooksAdmin);
router.post('/', booksController.createBook);
router.get('/without-file', booksController.getBooksWithoutFile);
router.put('/top-picks', booksController.setTopPicks);
router.put('/:id', booksController.updateBook);

module.exports = router;
