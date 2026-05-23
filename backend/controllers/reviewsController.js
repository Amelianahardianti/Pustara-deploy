/**
 * Reviews Controller
 * Returns recent community reviews for homepage widgets,
 * community stats, and handles review likes (pivot table).
 */

const db = require('../config/database');

function toRows(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.rows)) return result.rows;
  if (result && Array.isArray(result.recordset)) return result.recordset;
  return [];
}

// ── Ensure review_likes pivot table exists ─────────────────────────────────
async function ensureReviewLikesTable() {
  await db.executeQuery(`
    CREATE TABLE IF NOT EXISTS review_likes (
      review_id   UUID NOT NULL,
      user_id     TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (review_id, user_id)
    )
  `, []);
}

exports.getRecentReviews = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 8, 50);
    
    // Get authenticated user's ID (optional - for privacy check)
    let viewingUserId = null;
    if (req.user?.uid) {
      try {
        const userRows = toRows(
          await db.executeQuery(
            'SELECT id FROM users WHERE firebase_uid = $1 LIMIT 1',
            [req.user.uid]
          )
        );
        viewingUserId = userRows[0]?.id || null;
      } catch (_) {
        // If lookup fails, just continue without viewing_user_id
      }
    }

    // Privacy: Only show reviews where user has public_reviews=true OR viewing user is the owner
    const sql = `SELECT r.id AS review_id, r.*,
      u.firebase_uid,
      COALESCE(u.username, u.display_name) AS username,
        u.display_name,
        u.avatar_url,
        u.id AS user_id,
        b.id AS book_id, b.title AS book_title, b.authors, b.cover_url
      FROM reviews r
      LEFT JOIN users u ON r.user_id = u.id
      LEFT JOIN books b ON r.book_id = b.id
      WHERE (b.is_active IS NULL OR b.is_active = true)
        AND (
          COALESCE(u.public_reviews, true) = true
          OR r.user_id = $2
        )
      ORDER BY r.created_at DESC
      LIMIT $1`;

    let rows = [];
    try {
      rows = toRows(await db.executeQuery(sql, [limit, viewingUserId]));
    } catch (innerErr) {
      console.warn('Primary reviews query failed, trying fallback simple query:', innerErr.message || innerErr);
      try {
        // Fallback: just fetch without complex joins, but still respect privacy
        const fallbackSql = `SELECT r.* 
          FROM reviews r
          LEFT JOIN users u ON r.user_id = u.id
          WHERE COALESCE(u.public_reviews, true) = true OR r.user_id = $2
          ORDER BY r.created_at DESC LIMIT $1`;
        rows = toRows(await db.executeQuery(fallbackSql, [limit, viewingUserId]));
      } catch (fallbackErr) {
        throw fallbackErr;
      }
    }

    const reviews = rows.map((row) => {
      const text = row.review_text ?? row.body ?? row.text ?? row.content ?? '';
      const timeVal = row.created_at ?? row.created_at_utc ?? row.created ?? null;
      const authors = row.authors ?? row.book_authors ?? null;
      return {
        review_id: String(row.review_id || row.id || ''),
        firebase_uid: row.firebase_uid ? String(row.firebase_uid) : null,
        // display_name is the human-facing name shown on cards
        // Fall back to COALESCE username, then raw name field
        user: String(row.display_name || row.username || row.name || ''),
        avatar_url: row.avatar_url || row.user_avatar || null,
        rating: Number(row.rating ?? 0),
        book: String(row.book_title || row.book_title_raw || ''),
        author: Array.isArray(authors) ? (authors[0] || '') : (authors || ''),
        // cover_url is a direct URL stored in the books table
        cover_url: row.cover_url || null,
        key: String(row.book_id || row.bookId || row.book_key || ''),
        text: String(text),
        likes: Number(row.likes ?? 0),
        comments: Number(row.comments ?? 0),
        time: timeVal ? new Date(timeVal).toISOString() : null,
      };
    });

    res.json({ success: true, data: reviews, total: reviews.length });
  } catch (error) {
    console.error('Error fetching recent reviews:', error.message || error);
    res.status(500).json({ success: false, message: 'Failed to fetch recent reviews', error: error.message });
  }
};

/**
 * GET /community/stats  or  GET /reviews/stats
 * Returns real-time community counts: total readers, total reviews, positive-review %.
 * Only counts reviews where public_reviews=true (respects privacy)
 */
exports.getCommunityStats = async (req, res) => {
  try {
    const statsSql = `
      SELECT
        (SELECT COUNT(*) FROM users)::int                                         AS total_readers,
        (
          SELECT COUNT(*)
          FROM reviews r
          LEFT JOIN users u ON r.user_id = u.id
          WHERE COALESCE(u.public_reviews, true) = true
        )::int                                                                    AS total_reviews,
        (
          SELECT ROUND(
            100.0 * COUNT(*) FILTER (WHERE rating >= 4) / NULLIF(COUNT(*), 0), 1
          )
          FROM reviews r
          LEFT JOIN users u ON r.user_id = u.id
          WHERE COALESCE(u.public_reviews, true) = true
        )::numeric                                                                AS positive_pct
    `;

    let row = null;
    try {
      const rows = toRows(await db.executeQuery(statsSql, []));
      row = rows[0] || null;
    } catch (err) {
      console.warn('getCommunityStats query failed:', err.message || err);
    }

    const totalReaders = Number(row?.total_readers ?? 0);
    const totalReviews = Number(row?.total_reviews ?? 0);
    const positivePct  = Number(row?.positive_pct  ?? 0);

    function compact(n) {
      if (n >= 1_000_000) return `${Math.floor(n / 100_000) / 10}M+`;
      if (n >= 1_000)     return `${Math.floor(n / 100) / 10}K+`;
      return String(n);
    }

    res.json({
      success: true,
      data: {
        readers:      compact(totalReaders),
        reviews:      compact(totalReviews),
        positive_pct: `${Math.round(positivePct)}%`,
        raw: { total_readers: totalReaders, total_reviews: totalReviews, positive_pct: positivePct },
      },
    });
  } catch (error) {
    console.error('Error fetching community stats:', error.message || error);
    res.status(500).json({ success: false, message: 'Failed to fetch community stats', error: error.message });
  }
};

/**
 * POST /reviews/:id/like
 * Toggle like for a review. Requires authentication.
 * Uses review_likes pivot table to prevent duplicate likes and support unlike.
 */
exports.toggleReviewLike = async (req, res) => {
  const firebaseUid = req.user?.uid;
  if (!firebaseUid) {
    return res.status(401).json({ success: false, message: 'Login diperlukan untuk menyukai ulasan.' });
  }

  const reviewId = req.params.id;
  if (!reviewId) {
    return res.status(400).json({ success: false, message: 'review id is required' });
  }

  try {
    await ensureReviewLikesTable();

    // Resolve firebase uid → internal user id (text, since pivot stores TEXT user_id)
    const userRows = toRows(await db.executeQuery(
      'SELECT id FROM users WHERE firebase_uid = $1 LIMIT 1',
      [firebaseUid]
    ));
    if (userRows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    const userId = String(userRows[0].id);

    // Check if review exists
    const reviewRows = toRows(await db.executeQuery(
      'SELECT id, likes FROM reviews WHERE id = $1 LIMIT 1',
      [reviewId]
    ));
    if (reviewRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Review not found' });
    }

    // Check if already liked
    const existingLike = toRows(await db.executeQuery(
      'SELECT 1 FROM review_likes WHERE review_id = $1 AND user_id = $2 LIMIT 1',
      [reviewId, userId]
    ));

    let liked;
    if (existingLike.length > 0) {
      // Unlike
      await db.executeQuery(
        'DELETE FROM review_likes WHERE review_id = $1 AND user_id = $2',
        [reviewId, userId]
      );
      liked = false;
    } else {
      // Like
      await db.executeQuery(
        'INSERT INTO review_likes (review_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [reviewId, userId]
      );
      liked = true;
    }

    // Sync authoritative count back to reviews.likes
    const countRows = toRows(await db.executeQuery(
      'SELECT COUNT(*)::int AS cnt FROM review_likes WHERE review_id = $1',
      [reviewId]
    ));
    const newCount = Number(countRows[0]?.cnt ?? 0);

    await db.executeQuery(
      'UPDATE reviews SET likes = $1 WHERE id = $2',
      [newCount, reviewId]
    );

    res.json({ success: true, data: { liked, likes: newCount } });
  } catch (error) {
    console.error('Error toggling review like:', error.message || error);
    res.status(500).json({ success: false, message: 'Failed to toggle like', error: error.message });
  }
};

/**
 * GET /reviews/:id/like
 * Returns whether current user (optional auth) has liked this review + total count.
 */
exports.getReviewLikeStatus = async (req, res) => {
  const reviewId = req.params.id;
  if (!reviewId) {
    return res.status(400).json({ success: false, message: 'review id is required' });
  }

  try {
    await ensureReviewLikesTable();

    const firebaseUid = req.user?.uid;
    let liked = false;

    if (firebaseUid) {
      const userRows = toRows(await db.executeQuery(
        'SELECT id FROM users WHERE firebase_uid = $1 LIMIT 1',
        [firebaseUid]
      ));
      if (userRows.length > 0) {
        const userId = String(userRows[0].id);
        const existingLike = toRows(await db.executeQuery(
          'SELECT 1 FROM review_likes WHERE review_id = $1 AND user_id = $2 LIMIT 1',
          [reviewId, userId]
        ));
        liked = existingLike.length > 0;
      }
    }

    const countRows = toRows(await db.executeQuery(
      'SELECT likes FROM reviews WHERE id = $1 LIMIT 1',
      [reviewId]
    ));
    const likes = Number(countRows[0]?.likes ?? 0);

    res.json({ success: true, data: { liked, likes } });
  } catch (error) {
    console.error('Error fetching like status:', error.message || error);
    res.status(500).json({ success: false, message: 'Failed to fetch like status', error: error.message });
  }
};
