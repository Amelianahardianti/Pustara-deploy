const db = require('../config/database');

function toRows(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.rows)) return result.rows;
  if (result && Array.isArray(result.recordset)) return result.recordset;
  return [];
}

function normalizeNotificationType(type) {
  const allowed = new Set(['borrow', 'due', 'like', 'follow', 'review', 'system', 'queue']);
  const value = String(type || 'system').toLowerCase();
  return allowed.has(value) ? value : 'system';
}

async function insertNotification({ userId, type, title, body, bookId = null, actorId = null, data = null }) {
  if (!userId) return null;

  const notifType = normalizeNotificationType(type);
  const notifTitle = String(title || 'Pustara Notification');
  const notifBody = String(body || '');

  const queryVariants = [
    {
      sql: `INSERT INTO notifications (user_id, type, title, body, book_id, actor_id, read, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, false, CURRENT_TIMESTAMP)
            RETURNING id`,
      params: [userId, notifType, notifTitle, notifBody, bookId, actorId],
    },
    {
      sql: `INSERT INTO notifications (user_id, type, title, body, book_id, actor_id, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
            RETURNING id`,
      params: [userId, notifType, notifTitle, notifBody, bookId, actorId],
    },
    {
      sql: `INSERT INTO notifications (user_id, type, title, body, book_id, read)
            VALUES ($1, $2, $3, $4, $5, false)
            RETURNING id`,
      params: [userId, notifType, notifTitle, notifBody, bookId],
    },
    {
      sql: `INSERT INTO notifications (user_id, type, title, body, book_id)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id`,
      params: [userId, notifType, notifTitle, notifBody, bookId],
    },
    {
      sql: `INSERT INTO notifications (user_id, type, title, message, data, is_read, created_at)
            VALUES ($1, $2, $3, $4, $5, false, CURRENT_TIMESTAMP)
            RETURNING id`,
      params: [userId, notifType, notifTitle, notifBody, data || {}],
    },
    {
      sql: `INSERT INTO notifications (user_id, type, title, message, data, created_at)
            VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
            RETURNING id`,
      params: [userId, notifType, notifTitle, notifBody, data || {}],
    },
  ];

  let lastError = null;
  for (const variant of queryVariants) {
    try {
      const rows = toRows(await db.executeQuery(variant.sql, variant.params));
      return rows[0] || null;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    console.warn('[NotificationService] insertNotification failed:', lastError.message);
  }
  return null;
}

async function getUserContact(userId) {
  if (!userId) return null;

  const variants = [
    {
      sql: 'SELECT id, email, display_name, username FROM users WHERE id = $1 LIMIT 1',
      params: [userId],
    },
    {
      sql: 'SELECT TOP 1 id, email, display_name, username FROM users WHERE id = $1',
      params: [userId],
    },
  ];

  for (const variant of variants) {
    try {
      const rows = toRows(await db.executeQuery(variant.sql, variant.params));
      if (rows.length > 0) {
        const row = rows[0];
        return {
          id: String(row.id || userId),
          email: String(row.email || ''),
          name: String(row.display_name || row.username || 'Pustara Reader'),
        };
      }
    } catch (_) {
      // try next
    }
  }

  return null;
}

async function getAllNotifiableUsers(limit = 10000) {
  const variants = [
    {
      sql: 'SELECT id, email, display_name, username FROM users WHERE email IS NOT NULL ORDER BY created_at DESC LIMIT $1',
      params: [limit],
    },
    {
      sql: 'SELECT TOP 10000 id, email, display_name, username FROM users WHERE email IS NOT NULL ORDER BY created_at DESC',
      params: [],
    },
  ];

  for (const variant of variants) {
    try {
      const rows = toRows(await db.executeQuery(variant.sql, variant.params));
      if (rows.length > 0) {
        return rows
          .map((row) => ({
            id: String(row.id || ''),
            email: String(row.email || '').trim(),
            name: String(row.display_name || row.username || 'Pustara Reader'),
          }))
          .filter((row) => row.id && row.email && !row.email.endsWith('@firebase.local'));
      }
    } catch (_) {
      // try next
    }
  }

  return [];
}

module.exports = {
  insertNotification,
  getUserContact,
  getAllNotifiableUsers,
};
