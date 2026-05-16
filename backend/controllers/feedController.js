/**
 * Feed Controller
 * Handles user feed data: activity, reading sessions, notifications
 */

const db = require('../config/database');
const UserService = require('../services/userService');

function toRows(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.rows)) return result.rows;
  if (result && Array.isArray(result.recordset)) return result.recordset;
  return [];
}

function parseStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return [];

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item).trim()).filter(Boolean);
      }
    } catch (_) {
      // fallback to comma split
    }

    return raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function formatBook(row) {
  return {
    id: String(row.id || ''),
    title: String(row.title || ''),
    authors: parseStringArray(row.authors),
    genres: parseStringArray(row.genres),
    cover_url: row.cover_url ? String(row.cover_url) : '',
    avg_rating: Number(row.avg_rating || 0),
    year: Number(row.year || 0),
    pages: Number(row.pages || 0),
  };
}

async function resolveActorUserId(req) {
  if (!req.user?.uid) return null;

  const actor = await UserService.getUserByUid(req.user.uid);
  if (!actor.success || !actor.data?.id) return null;

  return String(actor.data.id);
}

async function fetchActivityRows(actorUserId, limit, includeNetwork = false) {
  const actorScope = includeNetwork
    ? `IN (SELECT following_id FROM follows WHERE follower_id = $1)`
    : `= $1`;

  const readingQuery = `SELECT
      b.id, b.title, b.authors, b.genres, b.cover_url, b.avg_rating, b.year, b.pages,
      rs.id as session_id, rs.status, rs.current_page, rs.total_pages,
      rs.progress_percentage, rs.started_at, rs.finished_at, rs.last_read_at,
      rs.reading_time_minutes,
      u.id AS actor_id, u.display_name, u.avatar_url,
      COALESCE(rs.last_read_at, rs.finished_at, rs.started_at) AS event_time
    FROM reading_sessions rs
    JOIN books b ON b.id = rs.book_id
    JOIN users u ON u.id = rs.user_id
    WHERE rs.user_id ${actorScope}
      AND b.is_active = true
      AND rs.status IN ('reading', 'active', 'finished')`;

  const wishlistQueryAddedAt = `SELECT
      b.id, b.title, b.authors, b.genres, b.cover_url, b.avg_rating, b.year, b.pages,
      NULL AS session_id, 'wishlist' AS status,
      0 AS current_page, 0 AS total_pages,
      0 AS progress_percentage,
      NULL AS started_at, NULL AS finished_at, NULL AS last_read_at,
      0 AS reading_time_minutes,
      u.id AS actor_id, u.display_name, u.avatar_url,
      w.added_at AS event_time
    FROM wishlist w
    JOIN books b ON b.id = w.book_id
    JOIN users u ON u.id = w.user_id
    WHERE w.user_id ${actorScope}
      AND b.is_active = true`;

  const wishlistQueryCreatedAt = `SELECT
      b.id, b.title, b.authors, b.genres, b.cover_url, b.avg_rating, b.year, b.pages,
      NULL AS session_id, 'wishlist' AS status,
      0 AS current_page, 0 AS total_pages,
      0 AS progress_percentage,
      NULL AS started_at, NULL AS finished_at, NULL AS last_read_at,
      0 AS reading_time_minutes,
      u.id AS actor_id, u.display_name, u.avatar_url,
      w.created_at AS event_time
    FROM wishlist w
    JOIN books b ON b.id = w.book_id
    JOIN users u ON u.id = w.user_id
    WHERE w.user_id ${actorScope}
      AND b.is_active = true`;

  const unionQuery = (wishlistQuery) => `
    SELECT *
    FROM (
      ${readingQuery}
      UNION ALL
      ${wishlistQuery}
    ) feed_events
    ORDER BY event_time DESC
    LIMIT $2`;

  try {
    return toRows(await db.executeQuery(unionQuery(wishlistQueryAddedAt), [actorUserId, limit]));
  } catch (_) {
    return toRows(await db.executeQuery(unionQuery(wishlistQueryCreatedAt), [actorUserId, limit]));
  }
}

/**
 * GET /feed/me/activity
 * Returns user's reading activity (current reads + finished reads)
 */
exports.getMyFeedActivity = async (req, res) => {
  try {
    const actorUserId = await resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const includeNetwork = String(req.query.include_network || req.query.scope || '').toLowerCase() === '1'
      || String(req.query.include_network || req.query.scope || '').toLowerCase() === 'network';

    const activityRows = await fetchActivityRows(actorUserId, limit, includeNetwork);

    const activities = activityRows.map((row) => ({
      type: row.status === 'finished' ? 'finish' : row.status === 'wishlist' ? 'wishlist' : 'read',
      book: formatBook(row),
      actor_id: row.actor_id ? String(row.actor_id) : null,
      status: row.status === 'finished' ? 'finished' : row.status === 'wishlist' ? 'wishlist' : 'reading',
      current_page: Number(row.current_page || 0),
      total_pages: Number(row.total_pages || 0),
      progress_percentage: Number(row.progress_percentage || 0),
      session_id: row.session_id
        ? String(row.session_id)
        : `activity_${String(row.actor_id || 'u')}_${String(row.id || 'b')}_${String(row.event_time || '')}`,
      started_at: row.started_at || null,
      finished_at: row.finished_at || null,
      last_read_at: row.last_read_at || null,
      reading_time_minutes: Number(row.reading_time_minutes || 0),
      actor_name: row.display_name || 'User',
      actor_avatar: row.avatar_url || null,
      timestamp: row.event_time || row.last_read_at || row.finished_at || row.started_at,
    }));

    res.json({
      success: true,
      data: {
        activities,
        total: activities.length,
        scope: includeNetwork ? 'network' : 'self',
      },
    });
  } catch (error) {
    console.error('Error fetching feed activity:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch feed activity',
      error: error.message,
    });
  }
};

/**
 * GET /feed/me/notifications
 * Returns user's notifications
 */
exports.getMyNotifications = async (req, res) => {
  try {
    const actorUserId = await resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    const limit = Math.min(Number(req.query.limit) || 20, 100);

    let notificationRows = [];
    const queryVariants = [
      {
        sql: `SELECT
               id, user_id, type, title,
               body, NULL AS message,
               book_id, NULL AS related_book_id,
               actor_id, NULL AS related_user_id,
               read, NULL AS is_read,
               created_at
             FROM notifications
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT $2`,
        params: [actorUserId, limit],
      },
      {
        sql: `SELECT
               id, user_id, type, title,
               NULL AS body, message,
               book_id, NULL AS related_book_id,
               actor_id, NULL AS related_user_id,
               NULL AS read, is_read,
               created_at
             FROM notifications
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT $2`,
        params: [actorUserId, limit],
      },
      {
        sql: `SELECT TOP 100
               id, user_id, type, title,
               body, NULL AS message,
               book_id, NULL AS related_book_id,
               actor_id, NULL AS related_user_id,
               read, NULL AS is_read,
               created_at
             FROM notifications
             WHERE user_id = $1
             ORDER BY created_at DESC`,
        params: [actorUserId],
      },
    ];

    let lastError = null;
    for (const variant of queryVariants) {
      try {
        notificationRows = toRows(await db.executeQuery(variant.sql, variant.params)).slice(0, limit);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) throw lastError;

    const notifications = notificationRows.map((row) => ({
      id: String(row.id || ''),
      type: String(row.type || 'info'),
      title: String(row.title || ''),
      body: String(row.body || row.message || ''),
      description: String(row.body || row.message || ''),
      actor_id: row.actor_id ? String(row.actor_id) : row.related_user_id ? String(row.related_user_id) : null,
      book_id: row.book_id ? String(row.book_id) : row.related_book_id ? String(row.related_book_id) : null,
      related_user_id: row.related_user_id ? String(row.related_user_id) : row.actor_id ? String(row.actor_id) : null,
      related_book_id: row.related_book_id ? String(row.related_book_id) : row.book_id ? String(row.book_id) : null,
      read: Boolean(row.read ?? row.is_read),
      is_read: Boolean(row.is_read ?? row.read),
      created_at: row.created_at || null,
      timestamp: row.created_at || null,
    }));

    res.json({
      success: true,
      data: {
        notifications,
        total: notifications.length,
      },
    });
  } catch (error) {
    console.error('Error fetching notifications:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch notifications',
      error: error.message,
    });
  }
};

/**
 * PATCH /feed/me/notifications/read
 * Marks one notification or all notifications as read.
 */
exports.markMyNotificationsRead = async (req, res) => {
  try {
    const actorUserId = await resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    const notificationId = req.params.notificationId || req.body?.notificationId || req.body?.id || null;
    const markAll = Boolean(req.body?.all) || !notificationId;

    const queryVariants = markAll
      ? [
          {
            sql: `UPDATE notifications
                  SET read = true
                  WHERE user_id = $1
                  RETURNING id`,
            params: [actorUserId],
          },
          {
            sql: `UPDATE notifications
                  SET is_read = true
                  WHERE user_id = $1
                  RETURNING id`,
            params: [actorUserId],
          },
          {
            sql: `UPDATE notifications
                  SET read = 1
                  WHERE user_id = $1`,
            params: [actorUserId],
          },
        ]
      : [
          {
            sql: `UPDATE notifications
                  SET read = true
                  WHERE user_id = $1 AND id = $2
                  RETURNING id`,
            params: [actorUserId, notificationId],
          },
          {
            sql: `UPDATE notifications
                  SET is_read = true
                  WHERE user_id = $1 AND id = $2
                  RETURNING id`,
            params: [actorUserId, notificationId],
          },
          {
            sql: `UPDATE notifications
                  SET read = 1
                  WHERE user_id = $1 AND id = $2`,
            params: [actorUserId, notificationId],
          },
        ];

    let updated = [];
    let lastError = null;
    for (const variant of queryVariants) {
      try {
        updated = toRows(await db.executeQuery(variant.sql, variant.params));
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) throw lastError;

    res.json({
      success: true,
      data: {
        read: true,
        all: markAll,
        notification_id: notificationId ? String(notificationId) : null,
        updated: updated.length,
      },
    });
  } catch (error) {
    console.error('Error marking notifications read:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to mark notifications read',
      error: error.message,
    });
  }
};

/**
 * DELETE /feed/me/notifications/:notificationId
 * Deletes one notification owned by the authenticated user.
 */
exports.deleteMyNotification = async (req, res) => {
  try {
    const actorUserId = await resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    const { notificationId } = req.params;
    if (!notificationId) {
      return res.status(400).json({
        success: false,
        message: 'notificationId is required',
      });
    }

    await db.executeQuery(
      'DELETE FROM notifications WHERE user_id = $1 AND id = $2',
      [actorUserId, notificationId]
    );

    res.json({
      success: true,
      data: {
        deleted: true,
        notification_id: String(notificationId),
      },
    });
  } catch (error) {
    console.error('Error deleting notification:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to delete notification',
      error: error.message,
    });
  }
};

/**
 * GET /feed/me/recommendations
 * Returns personalized recommendations for feed sidebar
 */
exports.getMyRecommendations = async (req, res) => {
  try {
    const actorUserId = await resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    const limit = Math.min(Number(req.query.limit) || 10, 50);

    // Get recommended users
    const recommendedUserRows = toRows(
      await db.executeQuery(
        `SELECT u.id, u.display_name, u.username, u.avatar_url, u.bio,
                COUNT(DISTINCT rs.book_id) as books_count
         FROM users u
         LEFT JOIN reading_sessions rs ON rs.user_id = u.id AND rs.status IN ('reading', 'finished')
         WHERE u.id <> $1
           AND u.id NOT IN (
             SELECT following_id FROM follows WHERE follower_id = $1
           )
         GROUP BY u.id
         ORDER BY books_count DESC, u.created_at DESC
         LIMIT $2`,
        [actorUserId, limit]
      )
    );

    const recommendations = {
      users: recommendedUserRows.map((row) => ({
        id: String(row.id || ''),
        name: String(row.display_name || row.username || 'User'),
        username: String(row.username || ''),
        avatar: row.avatar_url || null,
        bio: row.bio || '',
        books_count: Number(row.books_count || 0),
      })),
    };

    res.json({
      success: true,
      data: recommendations,
    });
  } catch (error) {
    console.error('Error fetching recommendations:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch recommendations',
      error: error.message,
    });
  }
};
