const EventEmitter = require('events');

// Central in-memory event emitter for server-instance real-time events.
// Note: works for single server instance. For multi-instance, replace
// with Redis pub/sub or a message broker.
const emitter = new EventEmitter();

function emitBookEvent(bookId, payload) {
  try {
    emitter.emit(`book:${bookId}`, payload);
  } catch (err) {
    console.warn('[Events] emitBookEvent failed:', err?.message || err);
  }
}

function subscribeBook(bookId, handler) {
  const key = `book:${bookId}`;
  emitter.on(key, handler);
  return () => emitter.off(key, handler);
}

module.exports = { emitter, emitBookEvent, subscribeBook };
