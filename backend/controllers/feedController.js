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
  // Explicit null/undefined check
  if (!value) return [];

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
  // Defensive null check for entire row
  if (!row) {
    return {
      id: '',
      title: 'Unknown Book',
      authors: [],
      genres: [],
      cover_url: '',
      avg_rating: 0,
      year: 0,
      pages: 0,
    };
  }

  const formatted = {
    id: String(row.id || ''),
    title: String(row.title || ''),
    authors: parseStringArray(row.authors),
    genres: parseStringArray(row.genres),
    cover_url: row.cover_url ? String(row.cover_url) : '',
    avg_rating: Number(row.avg_rating || 0),
    year: Number(row.year || 0),
    pages: Number(row.pages || 0),
  };

  if (!formatted.cover_url) {
    console.log('[Feed Cover] MISSING cover_url for book:', { bookId: formatted.id, title: formatted.title });
  }

  return formatted;
}

async function resolveActorUserId(req) {
  if (!req.user?.uid) return null;

  const actor = await UserService.getUserByUid(req.user.uid);
  if (actor.success && actor.data?.id) {
    return String(actor.data.id);
  }

  const email = req.user.email || null;
  if (email) {
    const created = await UserService.createUser(
      req.user.uid,
      email,
      req.user.name || req.user.displayName || null
    );

    if (created.success && created.data?.id) {
      return String(created.data.id);
    }
  }

  return null;
}

async function fetchActivityRows(actorUserId, limit, includeNetwork = false) {
const actorScope = includeNetwork
  ? `IN (
      SELECT following_id
      FROM follows
      WHERE follower_id = $1

      UNION

      SELECT $1
    )`
  : `= $1`;

  const readingQuery = `SELECT
      b.id, b.title, b.authors, b.genres, b.cover_url, b.avg_rating, b.year, b.pages,
      rs.id as session_id, rs.status, rs.current_page, rs.total_pages,
      rs.progress_percentage, rs.started_at, rs.finished_at, rs.last_read_at,
      rs.reading_time_minutes,
      u.id AS actor_id, u.display_name, u.avatar_url,
      NULL::text AS review_text,
      NULL::uuid AS review_id,
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
      NULL::text AS review_text,
      NULL::uuid AS review_id,
      w.added_at AS event_time
    FROM wishlist w
    JOIN books b ON b.id = w.book_id
    JOIN users u ON u.id = w.user_id
    WHERE w.user_id ${actorScope}
      AND b.is_active = true`;

const reviewQuery = `SELECT
      b.id, b.title, b.authors, b.genres, b.cover_url, b.avg_rating, b.year, b.pages,
      r.id AS session_id, 'review' AS status,
      r.rating AS current_page, 5 AS total_pages,
      0 AS progress_percentage,
      NULL AS started_at, NULL AS finished_at, NULL AS last_read_at,
      COALESCE(r.likes, 0) AS reading_time_minutes,
      u.id AS actor_id, u.display_name, u.avatar_url,
      r.body AS review_text,
      r.id AS review_id,
      r.created_at AS event_time
    FROM reviews r
    JOIN books b ON b.id = r.book_id
    JOIN users u ON u.id = r.user_id
    WHERE r.user_id ${actorScope}
      AND b.is_active = true
      AND COALESCE(u.public_reviews, true) = true`;

  const unionQuery = (wishlistQuery) => `
    SELECT *
    FROM (
      ${readingQuery}
      UNION ALL
      ${wishlistQuery}
      UNION ALL
      ${reviewQuery}
    ) feed_events
    ORDER BY event_time DESC
    LIMIT $2`;

  try {
    console.log('[FeedActivity] UNION query executing for user:', actorUserId);
    const result = toRows(await db.executeQuery(unionQuery(wishlistQueryAddedAt), [actorUserId, limit]));
    console.log('[FeedActivity] Rows:', result?.length || 0);
    return result;
  } catch (error) {
    console.error('[FeedActivity] UNION query failed:', {
      message: error.message,
      code: error.code,
    });
    throw error;
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
      console.warn('[FeedActivity] Auth failed - no actor user ID from token');
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const includeNetwork = String(req.query.include_network || req.query.scope || '').toLowerCase() === '1'
      || String(req.query.include_network || req.query.scope || '').toLowerCase() === 'network';

    console.log('[FeedActivity] Fetching for user:', actorUserId, 'limit:', limit, 'includeNetwork:', includeNetwork);

    const activityRows = await fetchActivityRows(actorUserId, limit, includeNetwork);

    console.log('[FeedActivity] Raw rows from DB:', activityRows.length);
    if (activityRows.length > 0) {
      console.log('[FeedActivity] First row keys:', Object.keys(activityRows[0]));
      console.log('[FeedActivity] First row cover_url:', activityRows[0]?.cover_url);
    }

    if (!Array.isArray(activityRows)) {
      console.error('[FeedActivity] fetchActivityRows returned non-array:', typeof activityRows);
      throw new Error('Invalid activity rows format from database');
    }

    const activities = activityRows.map((row) => {
      if (!row) {
        console.warn('[FeedActivity] Skipping null row');
        return null;
      }

      const isReview = row.status === 'review';
      const isWishlist = row.status === 'wishlist';
      const isReading = row.status === 'reading' || row.status === 'active';
      const isFinished = row.status === 'finished';

      const baseActivity = {
        type: isReview ? 'review' : isFinished ? 'finish' : isWishlist ? 'wishlist' : 'read',
        book: formatBook(row),
        actor_id: row.actor_id ? String(row.actor_id) : null,
        status: isReview ? 'review' : isFinished ? 'finished' : isWishlist ? 'wishlist' : 'reading',
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
      };

      // Include review-specific fields if this is a review activity
      if (isReview) {
        const reviewActivity = {
          ...baseActivity,
          review_id: row.review_id ? String(row.review_id) : null,
          review_text: row.review_text || null,
          review_rating: Number(row.current_page || 0),
          review_likes: Number(row.reading_time_minutes || 0),
        };
        console.log('[FeedActivity] Review activity:', {
          review_id: reviewActivity.review_id,
          actor_id: actorUserId,
          review_likes: reviewActivity.review_likes,
          note: 'Frontend will call /reviews/:id/like GET to fetch user-specific like state',
        });
        return reviewActivity;
      }

      return baseActivity;
    }).filter(Boolean); // Remove null entries

    console.log('[FeedActivity] Mapped activities:', activities.length);

    res.json({
      success: true,
      data: {
        activities,
        total: activities.length,
        scope: includeNetwork ? 'network' : 'self',
      },
    });
  } catch (error) {
    console.error('[FeedActivity] ERROR:', {
      message: error.message,
      code: error.code,
      detail: error.detail,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });

    res.status(500).json({
      success: false,
      message: 'Failed to fetch feed activity',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
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
               n.id, n.user_id, n.type, n.title,
               n.body, NULL AS message,
               n.book_id, NULL AS related_book_id,
               n.actor_id,
               u.username AS actor_username,
               n.read, NULL AS is_read,
               n.created_at
             FROM notifications n
             LEFT JOIN users u ON u.id = n.actor_id
             WHERE n.user_id = $1
             ORDER BY n.created_at DESC
             LIMIT $2`,
        params: [actorUserId, limit],
      },
      {
        sql: `SELECT
               n.id, n.user_id, n.type, n.title,
               NULL AS body, n.message,
               n.book_id, NULL AS related_book_id,
               n.actor_id,
               u.username AS actor_username,
               NULL AS read, n.is_read,
               n.created_at
             FROM notifications n
             LEFT JOIN users u ON u.id = n.actor_id
             WHERE n.user_id = $1
             ORDER BY n.created_at DESC
             LIMIT $2`,
        params: [actorUserId, limit],
      },
      {
        sql: `SELECT
               n.id, n.user_id, n.type, n.title,
               n.body, NULL AS message,
               n.book_id, NULL AS related_book_id,
               n.actor_id,
               u.username AS actor_username,
               n.read, NULL AS is_read,
               n.created_at
             FROM notifications n
             LEFT JOIN users u ON u.id = n.actor_id
             WHERE n.user_id = $1
             ORDER BY n.created_at DESC
             LIMIT $2`,
        params: [actorUserId, limit],
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
      actor_id: row.actor_id ? String(row.actor_id) : null,
      book_id: row.book_id ? String(row.book_id) : row.related_book_id ? String(row.related_book_id) : null,
      related_user_id: null,
      related_book_id: row.related_book_id ? String(row.related_book_id) : row.book_id ? String(row.book_id) : null,
      read: Boolean(row.read ?? row.is_read),
      actor_username: row.actor_username ? String(row.actor_username) : null,
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
