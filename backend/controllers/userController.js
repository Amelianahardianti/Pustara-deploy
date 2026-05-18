const db = require('../config/database');
const UserService = require('../services/userService');
const { insertNotification, getUserContact } = require('../services/notificationService');
const { sendEmail } = require('../services/emailService');

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

function buildGenreStats(rows, limit = 5) {
  const genreCounts = new Map();
  let totalGenreOccurrences = 0;

  for (const row of rows) {
    const genres = parseStringArray(row.genres);
    for (const genre of genres) {
      totalGenreOccurrences += 1;
      genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
    }
  }

  const topGenres = Array.from(genreCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'id'))
    .slice(0, limit)
    .map(([genre, count]) => ({
      genre,
      count: Number(count || 0),
    }));

  if (topGenres.length === 0) {
    return [];
  }

  const total = topGenres.reduce((sum, item) => sum + item.count, 0) || 1;
  const ranked = topGenres.map((item) => {
    const exact = (item.count / total) * 100;
    const base = Math.floor(exact);
    return {
      ...item,
      pct: base,
      remainder: exact - base,
    };
  });

  let remaining = 100 - ranked.reduce((sum, item) => sum + item.pct, 0);
  const order = [...ranked].sort((a, b) => b.remainder - a.remainder || b.count - a.count || a.genre.localeCompare(b.genre, 'id'));

  for (let index = 0; index < remaining; index += 1) {
    const target = order[index % order.length];
    target.pct += 1;
  }

  return ranked.map(({ genre, count, pct }) => ({ genre, count, pct }));
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

function nextDayKey(dayKey) {
  if (!dayKey) return null;
  const date = dayKeyToUtcDate(dayKey);
  if (!date) return null;
  date.setUTCDate(date.getUTCDate() + 1);
  return toDayKeyInTimeZone(date);
}

function buildStreakSummary(timestamps) {
  if (!Array.isArray(timestamps) || timestamps.length === 0) {
    return {
      currentStreak: 0,
      isActiveToday: false,
      lastActiveDayKey: null,
      lastStreakStartDayKey: null,
      lastStreakEndDayKey: null,
      lastStreakLength: 0,
      resetDayKey: null,
    };
  }

  const days = new Set();
  for (const ts of timestamps) {
    const key = toDayKeyInTimeZone(ts);
    if (key) days.add(key);
  }

  if (days.size === 0) {
    return {
      currentStreak: 0,
      isActiveToday: false,
      lastActiveDayKey: null,
      lastStreakStartDayKey: null,
      lastStreakEndDayKey: null,
      lastStreakLength: 0,
      resetDayKey: null,
    };
  }

  const sortedDays = Array.from(days).sort((a, b) => {
    const da = dayKeyToUtcDate(a);
    const db = dayKeyToUtcDate(b);
    return (db?.getTime() || 0) - (da?.getTime() || 0);
  });

  const latestDayKey = sortedDays[0];
  const todayDayKey = toDayKeyInTimeZone(new Date());
  let streakLength = 1;

  for (let i = 1; i < sortedDays.length; i += 1) {
    const diff = diffDays(sortedDays[i - 1], sortedDays[i]);
    if (diff === 1) {
      streakLength += 1;
      continue;
    }
    break;
  }

  const lastStreakEndDayKey = latestDayKey;
  const lastStreakStartDayKey = sortedDays[Math.max(0, streakLength - 1)];
  const isActiveToday = Boolean(todayDayKey && latestDayKey === todayDayKey);

  return {
    currentStreak: isActiveToday ? streakLength : 0,
    isActiveToday,
    lastActiveDayKey: latestDayKey,
    lastStreakStartDayKey,
    lastStreakEndDayKey,
    lastStreakLength: streakLength,
    resetDayKey: isActiveToday ? null : nextDayKey(lastStreakEndDayKey),
  };
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

  // If it already looks like a direct user ID, use it as-is.
  if (/^\d+$/.test(candidate) || /^[0-9a-fA-F-]{16,}$/.test(candidate)) {
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

async function getUserDisplaySummary(userId) {
  const rows = toRows(
    await db.executeQuery(
      'SELECT id, username, display_name, email FROM users WHERE id = $1 LIMIT 1',
      [userId]
    )
  );
  if (rows.length === 0) return { name: 'Pustara Reader', username: '' };
  const identity = buildPublicIdentity(rows[0]);
  return {
    name: identity.display_name,
    username: identity.username,
  };
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
      'SELECT id, firebase_uid, username, display_name, email, bio, avatar_url, preferred_genres, reading_streak, total_read, created_at, updated_at FROM users WHERE id = $1',
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
  let reviewsWritten = 0;
  let favoriteGenres = [];
  let computedStreak = 0;
  let streakSummary = {
    currentStreak: 0,
    isActiveToday: false,
    lastActiveDayKey: null,
    lastStreakStartDayKey: null,
    lastStreakEndDayKey: null,
    resetDayKey: null,
  };

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
    // Count finished history items using the same logic as /shelf/me
    const finishedCountRows = toRows(
      await db.executeQuery(
        `SELECT COUNT(*) AS total FROM (
           -- returned loans
           SELECT
             b.id,
             CASE
               WHEN rs.id IS NULL THEN 'unfinished'
               WHEN COALESCE(rs.progress_percentage, 0) >= 100
                 OR COALESCE(rs.current_page, 0) >= COALESCE(rs.total_pages, 0) THEN 'finished'
               ELSE 'unfinished'
             END AS history_status
           FROM loans l
           JOIN books b ON b.id = l.book_id
           LEFT JOIN LATERAL (
             SELECT id, current_page, total_pages, progress_percentage, finished_at, started_at, reading_time_minutes
             FROM reading_sessions
             WHERE book_id = l.book_id AND user_id = l.user_id
             ORDER BY COALESCE(finished_at, last_read_at, started_at) DESC
             LIMIT 1
           ) rs ON true
           WHERE l.user_id = $1
             AND b.is_active = true
             AND l.returned_at IS NOT NULL

           UNION ALL

           -- finished reading sessions that are not tied to a returned loan
           SELECT
             b.id,
             CASE
               WHEN COALESCE(rs.progress_percentage, 0) < 100
                OR COALESCE(rs.current_page, 0) < COALESCE(rs.total_pages, 0) THEN 'unfinished'
               ELSE 'finished'
             END AS history_status
           FROM reading_sessions rs
           JOIN books b ON b.id = rs.book_id
           WHERE rs.user_id = $1
             AND b.is_active = true
             AND rs.status = 'finished'
             AND NOT EXISTS (
               SELECT 1
               FROM loans l
               WHERE l.book_id = rs.book_id
                 AND l.user_id = rs.user_id
                 AND l.returned_at IS NOT NULL
             )
         ) sub WHERE history_status = 'finished'`,
        [targetUserId]
      )
    );
    finishedCount = Number(finishedCountRows[0]?.total ?? 0);
  } catch (_) {
    finishedCount = 0;
  }

  try {
    const borrowedGenreRows = toRows(
      await db.executeQuery(
        `SELECT b.genres
         FROM loans l
         JOIN books b ON b.id = l.book_id
         WHERE l.user_id = $1
           AND b.is_active = true`,
        [targetUserId]
      )
    );
    favoriteGenres = buildGenreStats(borrowedGenreRows, 5);
  } catch (_) {
    favoriteGenres = [];
  }

  let activeBorrowedCount = 0;
  try {
    const activeBorrowedRows = toRows(
      await db.executeQuery(
        `SELECT COUNT(DISTINCT b.id) AS total
         FROM loans l
         JOIN books b ON b.id = l.book_id
         WHERE l.user_id = $1
           AND b.is_active = true
           AND l.returned_at IS NULL
           AND l.status IN ('active', 'extended')`,
        [targetUserId]
      )
    );
    activeBorrowedCount = Number(activeBorrowedRows[0]?.total ?? 0);
  } catch (_) {
    activeBorrowedCount = 0;
  }

  try {
    const reviewRows = toRows(
      await db.executeQuery(
        `SELECT COUNT(*) AS total
         FROM reviews
         WHERE user_id = $1`,
        [targetUserId]
      )
    );
    reviewsWritten = Number(reviewRows[0]?.total || 0);
  } catch (_) {
    reviewsWritten = 0;
  }

  try {
    const streakRows = toRows(
      await db.executeQuery(
        `SELECT login_at AS event_time
         FROM login_events
         WHERE firebase_uid = $1
           AND login_at IS NOT NULL
         ORDER BY login_at DESC
         LIMIT 400`,
        [user.firebase_uid || user.uid || user.email || targetUserId]
      )
    );
    const streakTimestamps = streakRows.map((row) => row.event_time);
    computedStreak = calculateConsecutiveStreak(streakTimestamps);
    streakSummary = buildStreakSummary(streakTimestamps);
  } catch (_) {
    computedStreak = 0;
    streakSummary = {
      currentStreak: 0,
      isActiveToday: false,
      lastActiveDayKey: null,
      lastStreakStartDayKey: null,
      lastStreakEndDayKey: null,
      lastStreakLength: 0,
      resetDayKey: null,
    };
  }

  const storedStreak = Number(user.reading_streak || 0);
  const storedTotalRead = Number(user.total_read || 0);
  const resolvedStreak = Math.max(0, computedStreak, streakSummary.currentStreak);
  const resolvedTotalRead = Math.max(0, finishedCount);

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
    stats: {
      total_read: resolvedTotalRead,
      reading_streak: resolvedStreak,
      reviews_written: reviewsWritten,
      favorite_genres: favoriteGenres,
    },
    streak_is_active: streakSummary.isActiveToday,
    streak_last_length: streakSummary.lastStreakLength,
    streak_last_active_day: streakSummary.lastActiveDayKey,
    streak_last_start_day: streakSummary.lastStreakStartDayKey,
    streak_last_end_day: streakSummary.lastStreakEndDayKey,
    streak_reset_day: streakSummary.resetDayKey,
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
    const inputAvatarUrl = typeof req.body?.avatar_url === 'string' ? req.body.avatar_url.trim() : '';
    const inputPreferredGenres = req.body?.preferred_genres;

    if (inputName || inputDisplayName) {
      updates.display_name = inputDisplayName || inputName;
    }
    if (typeof req.body?.bio === 'string') {
      updates.bio = inputBio;
    }
    if (typeof req.body?.avatar_url === 'string') {
      updates.avatar_url = inputAvatarUrl || null;
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

      try {
        const actor = await getUserDisplaySummary(actorUserId);
        const body = `${actor.name} mulai mengikuti aktivitas membacamu di Pustara.`;

        await insertNotification({
          userId: targetUserId,
          type: 'follow',
          title: 'Pengikut Baru',
          body,
          actorId: actorUserId,
          data: {
            follower_id: actorUserId,
            follower_username: actor.username,
          },
        });

        const contact = await getUserContact(targetUserId);
        if (contact?.email) {
          await sendEmail({
            to: contact.email,
            subject: 'Pustara - Ada Pengikut Baru',
            text: [
              `Halo ${contact.name || 'Pustara Reader'},`,
              '',
              body,
              '',
              'Buka Pustara untuk melihat profil dan aktivitas terbaru.',
            ].join('\n'),
          }).catch((mailError) => {
            console.warn('Follow email warning:', mailError.message);
          });
        }
      } catch (notifyError) {
        console.warn('Follow notification warning:', notifyError.message);
      }
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

exports.searchUsers = async (req, res) => {
  try {
    const actorId = await resolveActorUserId(req);
    const query = String(req.query.q || req.query.query || '').trim();
    const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit || 12), 10) || 12, 1), 20);

    if (!query) {
      return res.json({
        success: true,
        data: [],
        meta: { total: 0, limit, query },
      });
    }

    const rows = toRows(
      await db.executeQuery(
        `SELECT u.id, u.username, u.display_name, u.bio, u.avatar_url, u.preferred_genres,
                u.total_read, u.reading_streak,
                (SELECT COUNT(*) FROM follows f WHERE f.following_id = u.id) AS followers_count,
                ${actorId ? `EXISTS(
                  SELECT 1
                  FROM follows f2
                  WHERE f2.follower_id = $2
                    AND f2.following_id = u.id
                )` : 'false'} AS is_following
         FROM users u
         WHERE (${actorId ? 'u.id <> $2 AND' : ''} (
           u.username ILIKE $1
           OR COALESCE(u.display_name, '') ILIKE $1
           OR COALESCE(u.bio, '') ILIKE $1
         ))
         ORDER BY followers_count DESC, u.total_read DESC, u.created_at DESC
         LIMIT $${actorId ? 3 : 2}`,
        actorId ? [`%${query}%`, actorId, limit] : [`%${query}%`, limit]
      )
    );

    const data = rows.map((user) => mapUserCard(user, Boolean(user.is_following)));

    res.json({
      success: true,
      data,
      meta: { total: data.length, limit, query },
    });
  } catch (error) {
    console.error('Error searching users:', error.message);
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
