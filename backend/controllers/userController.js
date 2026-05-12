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

function formatBookSummary(row) {
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

function toNonEmptyString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function toShortId(value) {
  const compact = String(value || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return compact.slice(0, 6) || 'reader';
}

function looksGeneratedHandle(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return true;

  // Common Firebase-like anonymous handles (u_xxx...) or long random IDs.
  if (/^u_[a-z0-9_]{12,}$/.test(raw)) return true;
  if (/^[a-z0-9_]{24,}$/.test(raw) && !/[aeiou]/.test(raw)) return true;

  return false;
}

function toHandle(value, fallbackId) {
  const source = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s.]/g, ' ')
    .replace(/[.\-\s]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (source.length >= 3 && !looksGeneratedHandle(source)) {
    return source.slice(0, 24);
  }

  return `pustara_${toShortId(fallbackId)}`;
}

/**
 * Normalize username candidate to match frontend register flow exactly.
 */
function normalizeUsernameCandidate(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s.]/g, ' ')
    .replace(/[.\-\s]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toDisplayName(value, fallbackId) {
  const text = toNonEmptyString(value);
  if (text && !looksGeneratedHandle(text)) return text;
  return `Pembaca ${toShortId(fallbackId)}`;
}

function buildPublicIdentity(userLike) {
  const id = String(userLike?.id || '');
  const rawDisplayName = toNonEmptyString(userLike?.display_name);
  const rawUsername = toNonEmptyString(userLike?.username);
  const emailLocal = toNonEmptyString(userLike?.email)
    ? String(userLike.email).split('@')[0]
    : null;

  const display_name = toDisplayName(rawDisplayName || emailLocal || rawUsername, id);
  const username = toHandle(rawUsername || rawDisplayName || emailLocal, id);

  return {
    display_name,
    username,
    name: display_name,
  };
}

const STREAK_TIME_ZONE = 'Asia/Jakarta';
const STREAK_DAY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: STREAK_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function toDayKeyInTimeZone(input) {
  if (!input) return null;
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return null;

  const parts = STREAK_DAY_FORMATTER.formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
}

function previousDayKey(dayKey) {
  if (!dayKey) return null;
  const [year, month, day] = dayKey.split('-').map((value) => Number(value));
  if (!year || !month || !day) return null;

  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - 1);
  return toDayKeyInTimeZone(date);
}

function dayKeyToUtcDate(dayKey) {
  if (!dayKey) return null;
  const [year, month, day] = String(dayKey).split('-').map((value) => Number(value));
  if (!year || !month || !day) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

function diffDays(dayA, dayB) {
  const a = dayKeyToUtcDate(dayA);
  const b = dayKeyToUtcDate(dayB);
  if (!a || !b) return Number.NaN;
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((a.getTime() - b.getTime()) / MS_PER_DAY);
}

function calculateConsecutiveStreak(timestamps) {
  if (!Array.isArray(timestamps) || timestamps.length === 0) return 0;

  const days = new Set();
  for (const ts of timestamps) {
    const key = toDayKeyInTimeZone(ts);
    if (key) days.add(key);
  }
  if (days.size === 0) return 0;

  const sortedDays = Array.from(days).sort((a, b) => {
    const da = dayKeyToUtcDate(a);
    const db = dayKeyToUtcDate(b);
    return (db?.getTime() || 0) - (da?.getTime() || 0);
  });

  let streak = 1;
  for (let i = 1; i < sortedDays.length; i += 1) {
    const diff = diffDays(sortedDays[i - 1], sortedDays[i]);
    if (diff === 1) {
      streak += 1;
      continue;
    }
    break;
  }

  return streak;
}

async function resolveActorUserId(req) {
  if (!req.user?.uid) return null;

  const actor = await UserService.getUserByUid(req.user.uid);
  if (!actor.success || !actor.data?.id) return null;

  return String(actor.data.id);
}

/**
 * Resolve a username or numeric ID to a user ID (numeric ID)
 * @param {string} usernameOrId - Username or numeric ID
 * @returns {Promise<string|null>} - User ID or null if not found
 */
async function resolveUsernameOrIdToUserId(usernameOrId) {
  if (!usernameOrId) return null;

  const normalized = String(usernameOrId).trim();
  const decoded = (() => {
    try {
      return decodeURIComponent(normalized);
    } catch (_) {
      return normalized;
    }
  })();
  const candidate = decoded.startsWith('@') ? decoded.slice(1) : decoded;

  // If it's a numeric ID, try that first
  if (/^\d+$/.test(candidate)) {
    return candidate;
  }

  // Otherwise, treat it as a username and query
  try {
    const rows = toRows(
      await db.executeQuery(
        'SELECT id FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1',
        [candidate]
      )
    );

    if (rows.length > 0) {
      return String(rows[0].id);
    }
  } catch (err) {
    console.error('Error resolving username:', err.message);
  }

  return null;
}

async function countFollowers(userId) {
  const rows = toRows(
    await db.executeQuery('SELECT COUNT(*) AS total FROM follows WHERE following_id = $1', [userId])
  );
  return Number(rows[0]?.total || 0);
}

async function countFollowing(userId) {
  const rows = toRows(
    await db.executeQuery('SELECT COUNT(*) AS total FROM follows WHERE follower_id = $1', [userId])
  );
  return Number(rows[0]?.total || 0);
}

function mapUserCard(user, isFollowing = false) {
  return {
    id: String(user.id),
    ...buildPublicIdentity(user),
    bio: user.bio || '',
    avatar_url: user.avatar_url || null,
    preferred_genres: parseStringArray(user.preferred_genres),
    followers_count: Number(user.followers_count || 0),
    total_read: Number(user.total_read || 0),
    reading_streak: Number(user.reading_streak || 0),
    is_following: Boolean(isFollowing),
  };
}

async function buildUserProfile(targetUserId, actorId = null) {
  const userRows = toRows(
    await db.executeQuery(
      'SELECT id, username, display_name, email, bio, avatar_url, preferred_genres, reading_streak, total_read, created_at, updated_at FROM users WHERE id = $1',
      [targetUserId]
    )
  );

  if (userRows.length === 0) {
    return null;
  }

  const user = userRows[0];
  const identity = buildPublicIdentity(user);

  const [followersCount, followingCount] = await Promise.all([
    countFollowers(targetUserId),
    countFollowing(targetUserId),
  ]);

  let isFollowing = false;
  if (actorId && actorId !== targetUserId) {
    const followRows = toRows(
      await db.executeQuery(
        'SELECT follower_id FROM follows WHERE follower_id = $1 AND following_id = $2',
        [actorId, targetUserId]
      )
    );
    isFollowing = followRows.length > 0;
  }

  let currentlyReading = [];
  let likedBooks = [];
  let finishedCount = 0;
  let computedStreak = 0;

  try {
    const readingRows = toRows(
      await db.executeQuery(
        `SELECT b.id, b.title, b.authors, b.genres, b.cover_url, b.avg_rating, b.year, b.pages,
                rs.progress_percentage, rs.last_read_at
         FROM reading_sessions rs
         JOIN books b ON b.id = rs.book_id
         WHERE rs.user_id = $1
           AND b.is_active = true
           AND (rs.status = 'reading' OR rs.status = 'active')
         ORDER BY rs.last_read_at DESC
         LIMIT 5`,
        [targetUserId]
      )
    );

    currentlyReading = readingRows.map((row) => ({
      ...formatBookSummary(row),
      progress_percentage: Number(row.progress_percentage || 0),
      last_read_at: row.last_read_at || null,
    }));
  } catch (_) {
    currentlyReading = [];
  }

  try {
    const likedRows = toRows(
      await db.executeQuery(
        `SELECT b.id, b.title, b.authors, b.genres, b.cover_url, b.avg_rating, b.year, b.pages, w.added_at
         FROM wishlist w
         JOIN books b ON b.id = w.book_id
         WHERE w.user_id = $1
           AND b.is_active = true
         ORDER BY w.added_at DESC
         LIMIT 10`,
        [targetUserId]
      )
    );

    likedBooks = likedRows.map((row) => ({
      ...formatBookSummary(row),
      liked_at: row.added_at || null,
    }));
  } catch (_) {
    likedBooks = [];
  }

  try {
    const finishedRows = toRows(
      await db.executeQuery(
        `SELECT COUNT(*) AS total
         FROM reading_sessions
         WHERE user_id = $1
           AND status = 'finished'`,
        [targetUserId]
      )
    );
    finishedCount = Number(finishedRows[0]?.total || 0);
  } catch (_) {
    finishedCount = 0;
  }

  try {
    const streakRows = toRows(
      await db.executeQuery(
        `SELECT COALESCE(last_read_at, finished_at, started_at) AS event_time
         FROM reading_sessions
         WHERE user_id = $1
           AND COALESCE(last_read_at, finished_at, started_at) IS NOT NULL
           AND status IN ('reading', 'active', 'finished')
         ORDER BY COALESCE(last_read_at, finished_at, started_at) DESC
         LIMIT 400`,
        [targetUserId]
      )
    );
    computedStreak = calculateConsecutiveStreak(streakRows.map((row) => row.event_time));
  } catch (_) {
    computedStreak = 0;
  }

  const storedStreak = Number(user.reading_streak || 0);
  const storedTotalRead = Number(user.total_read || 0);
  const resolvedStreak = computedStreak > 0 ? computedStreak : Math.max(0, storedStreak);
  const resolvedTotalRead = Math.max(0, storedTotalRead, finishedCount);

  return {
    id: String(user.id),
    username: identity.username,
    display_name: identity.display_name,
    name: identity.name,
    email: user.email || null,
    bio: user.bio || '',
    avatar_url: user.avatar_url || null,
    preferred_genres: parseStringArray(user.preferred_genres),
    total_read: resolvedTotalRead,
    reading_streak: resolvedStreak,
    created_at: user.created_at || null,
    updated_at: user.updated_at || null,
    followers_count: followersCount,
    following_count: followingCount,
    is_following: isFollowing,
    currently_reading: currentlyReading,
    liked_books: likedBooks,
  };
}

exports.getUserProfile = async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`[getUserProfile] Incoming request for: ${id}`);
    const actorId = await resolveActorUserId(req);

    // Resolve username or ID to actual user ID
    const targetUserId = await resolveUsernameOrIdToUserId(id);
    console.log(`[getUserProfile] Resolved ID: ${targetUserId}`);
    
    if (!targetUserId) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        error: { code: 'USER_NOT_FOUND', id },
      });
    }

    const profile = await buildUserProfile(targetUserId, actorId);
    if (!profile) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        error: { code: 'USER_NOT_FOUND', id },
      });
    }

    res.json({
      success: true,
      data: profile,
    });
  } catch (error) {
    console.error('Error fetching user profile:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getMyProfile = async (req, res) => {
  try {
    const actorUserId = await resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    const profile = await buildUserProfile(actorUserId, actorUserId);
    if (!profile) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    res.json({ success: true, data: profile });
  } catch (error) {
    console.error('Error fetching self profile:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.checkUsernameAvailability = async (req, res) => {
  try {
    const rawUsername = typeof req.query?.username === 'string' ? req.query.username : '';
    const normalizedUsername = normalizeUsernameCandidate(rawUsername);

    if (!normalizedUsername || normalizedUsername.length < 3) {
      return res.json({
        success: true,
        available: false,
        message: 'Username terlalu pendek (min. 3 karakter).'
      });
    }

    // Query ke Neon DB
    const rows = toRows(
      await db.executeQuery(
        'SELECT id FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1',
        [normalizedUsername]
      )
    );

    return res.json({
      success: true,
      available: rows.length === 0,
      username: normalizedUsername,
      normalizedUsername,
      message: rows.length === 0 ? 'Username tersedia.' : 'Username sudah digunakan.'
    });
  } catch (error) {
    console.error('Error checking username availability:', error.message);
    return res.status(500).json({
      success: false,
      available: false,
      message: 'Gagal memeriksa username.'
    });
  }
};

exports.updateMyProfile = async (req, res) => {
  try {
    if (!req.user?.uid) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    const updates = {};
    const inputName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const inputDisplayName = typeof req.body?.display_name === 'string' ? req.body.display_name.trim() : '';
    const inputUsername = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const inputBio = typeof req.body?.bio === 'string' ? req.body.bio.trim() : '';
    const inputPreferredGenres = req.body?.preferred_genres;

    if (inputName || inputDisplayName) {
      updates.display_name = inputDisplayName || inputName;
    }
    if (typeof req.body?.bio === 'string') {
      updates.bio = inputBio;
    }

    if (typeof req.body?.username === 'string') {
      const normalizedUsername = normalizeUsernameCandidate(inputUsername);

      if (!normalizedUsername || normalizedUsername.length < 3 || normalizedUsername.length > 24) {
        return res.status(400).json({
          success: false,
          message: 'Username harus 3-24 karakter (huruf kecil, angka, underscore).',
        });
      }

      const actorResult = await UserService.getUserByUid(req.user.uid);
      if (!actorResult.success || !actorResult.data?.id) {
        return res.status(404).json({
          success: false,
          message: 'User tidak ditemukan.',
        });
      }

      const actorId = String(actorResult.data.id);
      const conflictRows = toRows(
        await db.executeQuery(
          'SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND id <> $2 LIMIT 1',
          [normalizedUsername, actorId]
        )
      );

      if (conflictRows.length > 0) {
        return res.status(409).json({
          success: false,
          message: 'Username sudah digunakan pengguna lain.',
        });
      }

      updates.username = normalizedUsername;
    }

    if (Array.isArray(inputPreferredGenres)) {
      updates.preferred_genres = JSON.stringify(
        inputPreferredGenres.map((genre) => String(genre).trim()).filter(Boolean)
      );
    } else if (typeof inputPreferredGenres === 'string') {
      updates.preferred_genres = inputPreferredGenres;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid profile fields to update',
      });
    }

    const updateResult = await UserService.updateUser(req.user.uid, updates);
    if (!updateResult.success || !updateResult.data) {
      return res.status(400).json({
        success: false,
        message: updateResult.error || 'Failed to update profile',
      });
    }

    const actorUserId = String(updateResult.data.id);
    const profile = await buildUserProfile(actorUserId, actorUserId);

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: profile,
    });
  } catch (error) {
    console.error('Error updating self profile:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.followUser = async (req, res) => {
  try {
    const { id } = req.params;
    const actorUserId = await resolveActorUserId(req);

    if (!actorUserId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required to follow user',
      });
    }

    // Resolve username or ID to actual user ID
    const targetUserId = await resolveUsernameOrIdToUserId(id);
    if (!targetUserId) {
      return res.status(404).json({
        success: false,
        message: 'Target user not found',
      });
    }

    if (actorUserId === targetUserId) {
      return res.status(400).json({
        success: false,
        message: 'You cannot follow yourself',
      });
    }

    const userRows = toRows(
      await db.executeQuery('SELECT id FROM users WHERE id = $1', [targetUserId])
    );
    if (userRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Target user not found',
      });
    }

    const existingRows = toRows(
      await db.executeQuery(
        'SELECT follower_id FROM follows WHERE follower_id = $1 AND following_id = $2',
        [actorUserId, targetUserId]
      )
    );

    if (existingRows.length === 0) {
      await db.executeQuery(
        'INSERT INTO follows (follower_id, following_id, created_at) VALUES ($1, $2, CURRENT_TIMESTAMP)',
        [actorUserId, targetUserId]
      );
    }

    const [followersCount, followingCount] = await Promise.all([
      countFollowers(targetUserId),
      countFollowing(actorUserId),
    ]);

    res.json({
      success: true,
      message: 'Followed successfully',
      data: {
        follower_id: actorUserId,
        following_id: targetUserId,
        target_followers_count: followersCount,
        actor_following_count: followingCount,
        is_following: true,
      },
    });
  } catch (error) {
    console.error('Error following user:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.unfollowUser = async (req, res) => {
  try {
    const { id } = req.params;
    const actorUserId = await resolveActorUserId(req);

    if (!actorUserId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required to unfollow user',
      });
    }

    // Resolve username or ID to actual user ID
    const targetUserId = await resolveUsernameOrIdToUserId(id);
    if (!targetUserId) {
      return res.status(404).json({
        success: false,
        message: 'Target user not found',
      });
    }

    await db.executeQuery(
      'DELETE FROM follows WHERE follower_id = $1 AND following_id = $2',
      [actorUserId, targetUserId]
    );

    const [followersCount, followingCount] = await Promise.all([
      countFollowers(targetUserId),
      countFollowing(actorUserId),
    ]);

    res.json({
      success: true,
      message: 'Unfollowed successfully',
      data: {
        follower_id: actorUserId,
        following_id: targetUserId,
        target_followers_count: followersCount,
        actor_following_count: followingCount,
        is_following: false,
      },
    });
  } catch (error) {
    console.error('Error unfollowing user:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getRecommendedUsers = async (req, res) => {
  try {
    const actorId = await resolveActorUserId(req);
    const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit || 8), 10) || 8, 5), 10);

    const params = [];
    let whereClause = '';

    if (actorId) {
      whereClause = `WHERE u.id <> $1
        AND NOT EXISTS (
          SELECT 1
          FROM follows f
          WHERE f.follower_id = $1
            AND f.following_id = u.id
        )`;
      params.push(actorId);
    }

    params.push(limit);

    const recommendationRows = toRows(
      await db.executeQuery(
        `SELECT u.id, u.username, u.display_name, u.bio, u.avatar_url, u.preferred_genres,
                u.total_read, u.reading_streak,
                (SELECT COUNT(*) FROM follows f WHERE f.following_id = u.id) AS followers_count
         FROM users u
         ${whereClause}
         ORDER BY followers_count DESC, u.total_read DESC, u.created_at DESC
         LIMIT $${params.length}`,
        params
      )
    );

    const data = recommendationRows.map((user) => ({
      id: String(user.id),
      ...buildPublicIdentity(user),
      bio: user.bio || '',
      avatar_url: user.avatar_url || null,
      preferred_genres: parseStringArray(user.preferred_genres),
      followers_count: Number(user.followers_count || 0),
      total_read: Number(user.total_read || 0),
      reading_streak: Number(user.reading_streak || 0),
      is_following: false,
    }));

    res.json({
      success: true,
      data,
      meta: {
        total: data.length,
        limit,
      },
    });
  } catch (error) {
    console.error('Error fetching recommended users:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getMyFollowing = async (req, res) => {
  try {
    const actorId = await resolveActorUserId(req);
    if (!actorId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit || 30), 10) || 30, 1), 100);

    const rows = toRows(
      await db.executeQuery(
        `SELECT u.id, u.username, u.display_name, u.bio, u.avatar_url, u.preferred_genres,
                u.total_read, u.reading_streak,
                (SELECT COUNT(*) FROM follows f2 WHERE f2.following_id = u.id) AS followers_count
         FROM follows f
         JOIN users u ON u.id = f.following_id
         WHERE f.follower_id = $1
         ORDER BY f.created_at DESC
         LIMIT $2`,
        [actorId, limit]
      )
    );

    const data = rows.map((user) => mapUserCard(user, true));

    res.json({
      success: true,
      data,
      meta: { total: data.length, limit },
    });
  } catch (error) {
    console.error('Error fetching following list:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getMyFollowers = async (req, res) => {
  try {
    const actorId = await resolveActorUserId(req);
    if (!actorId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit || 30), 10) || 30, 1), 100);

    const rows = toRows(
      await db.executeQuery(
        `SELECT u.id, u.username, u.display_name, u.bio, u.avatar_url, u.preferred_genres,
                u.total_read, u.reading_streak,
                (SELECT COUNT(*) FROM follows f2 WHERE f2.following_id = u.id) AS followers_count
         FROM follows f
         JOIN users u ON u.id = f.follower_id
         WHERE f.following_id = $1
         ORDER BY f.created_at DESC
         LIMIT $2`,
        [actorId, limit]
      )
    );

    const followingRows = toRows(
      await db.executeQuery('SELECT following_id FROM follows WHERE follower_id = $1', [actorId])
    );
    const followingSet = new Set(followingRows.map((row) => String(row.following_id)));

    const data = rows.map((user) => mapUserCard(user, followingSet.has(String(user.id))));

    res.json({
      success: true,
      data,
      meta: { total: data.length, limit },
    });
  } catch (error) {
    console.error('Error fetching followers list:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};
