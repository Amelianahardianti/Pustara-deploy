const cron   = require('node-cron');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis'); 
// Import isNeon to make queries compatible with both Neon and Azure
const { executeQuery, isNeon } = require('../config/database');   
const { insertNotification, getAllNotifiableUsers } = require('../services/notificationService');
const { sendEmail } = require('../services/emailService');

const FASTAPI_URL = process.env.FASTAPI_URL;
const HF_TOKEN    = process.env.HF_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET || process.env.RI_SECRET; // Fallback just in case

// Helper log
function log(job, msg) {
  const ts = new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' });
  console.log(`[CRON ${ts}] [${job}] ${msg}`);
}

// Initialize Redis Upstash
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const STREAM_CURSOR_KEY = 'sync:activity_stream:last_id';
const DIGEST_SNAPSHOT_KEY = 'mail:digest:last_hash';
const DIGEST_SENT_AT_KEY = 'mail:digest:last_sent_at';

const USER_ID_CACHE = new Map();
const BOOK_ID_CACHE = new Map();

function toRows(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.rows)) return result.rows;
  if (result && Array.isArray(result.recordset)) return result.recordset;
  return [];
}

function stableHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

async function safeRedisGet(key) {
  try {
    return await redis.get(key);
  } catch {
    return null;
  }
}

async function safeRedisSet(key, value) {
  try {
    await redis.set(key, value);
  } catch (_) {
    // noop
  }
}

async function fetchLatestBooks(limit = 6) {
  const neonSql = `
    SELECT id::text AS id, title, created_at
    FROM books
    WHERE is_active = true
    ORDER BY created_at DESC
    LIMIT $1
  `;
  const azureSql = `
    SELECT TOP 6 CAST(id AS NVARCHAR(255)) AS id, title, created_at
    FROM books
    WHERE is_active = 1
    ORDER BY created_at DESC
  `;

  const rows = isNeon
    ? toRows(await executeQuery(neonSql, [limit]))
    : toRows(await executeQuery(azureSql, []));

  return rows.map((row) => ({ id: String(row.id || ''), title: String(row.title || ''), created_at: row.created_at || null }));
}

async function fetchCurrentTrending(limit = 6) {
  try {
    const res = await fetch(`${FASTAPI_URL}/recommendations/trending?top_n=${limit}`, {
      headers: { Authorization: `Bearer ${HF_TOKEN}` },
      signal: AbortSignal.timeout(15000), // Pengganti timeout axios
    });
    
    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
    const data = await res.json();
    
    const list = Array.isArray(data?.trending)
      ? data.trending
      : Array.isArray(data?.recommendations)
        ? data.recommendations
        : [];

    return list.slice(0, limit).map((item) => ({
      book_id: String(item.book_id || item.id || ''),
      title: String(item.title || ''),
      score: Number(item.trending_score || 0),
    }));
  } catch (error) {
    log('DIGEST', `Trending fetch warning: ${error.message}`);
    return [];
  }
}

async function sendCommunityDigestIfNeeded() {
  log('DIGEST', 'Checking for new digest-worthy updates...');

  try {
    const [latestBooks, trending, users, lastAiRebuildAt] = await Promise.all([
      fetchLatestBooks(6),
      fetchCurrentTrending(6),
      getAllNotifiableUsers(),
      safeRedisGet('ai:last_rebuild_at'),
    ]);

    const digestPayload = {
      newestBookIds: latestBooks.map((book) => book.id),
      trendingIds: trending.map((book) => book.book_id),
      lastAiRebuildAt: String(lastAiRebuildAt || ''),
    };
    const digestHash = stableHash(digestPayload);
    const previousHash = await safeRedisGet(DIGEST_SNAPSHOT_KEY);

    if (previousHash && previousHash === digestHash) {
      log('DIGEST', 'No new changes detected. Skipping digest send.');
      return;
    }

    if (users.length === 0) {
      log('DIGEST', 'No users with deliverable emails.');
      await safeRedisSet(DIGEST_SNAPSHOT_KEY, digestHash);
      return;
    }

    const newBooksText = latestBooks.length > 0
      ? latestBooks.map((book, idx) => `${idx + 1}. ${book.title}`).join('\n')
      : 'Belum ada data buku baru.';

    const trendingText = trending.length > 0
      ? trending.map((book, idx) => `${idx + 1}. ${book.title}`).join('\n')
      : 'Belum ada data trending saat ini.';

    const aiLine = lastAiRebuildAt
      ? `PustarAI terakhir sinkron katalog pada: ${lastAiRebuildAt}`
      : 'Status sinkronisasi PustarAI belum tersedia.';

    await Promise.all(users.map(async (user) => {
      await insertNotification({
        userId: user.id,
        type: 'system',
        title: 'Update Terbaru Pustara',
        body: 'Ada update baru: katalog terbaru, trending terkini, dan pembaruan PustarAI.',
      });

      await sendEmail({
        to: user.email,
        subject: 'Pustara - Update Baru (Trending + Katalog + PustarAI)',
        text: [
          `Halo ${user.name || 'Pustara Reader'},`,
          '',
          'Ada update baru di Pustara:',
          '',
          'Buku terbaru:',
          newBooksText,
          '',
          'Sedang trending:',
          trendingText,
          '',
          aiLine,
          '',
          'Yuk buka Pustara untuk cek update lengkapnya.',
        ].join('\n'),
      }).catch((err) => {
        log('DIGEST', `Email warning for ${user.email}: ${err.message}`);
      });
    }));

    await safeRedisSet(DIGEST_SNAPSHOT_KEY, digestHash);
    await safeRedisSet(DIGEST_SENT_AT_KEY, new Date().toISOString());
    log('DIGEST', `Digest sent to ${users.length} users.`);
  } catch (error) {
    log('DIGEST', `❌ Error: ${error.message}`);
  }
}

async function sendLoanDeadlineReminders() {
  log('LOANS', 'Checking due-date reminders and overdue loans...');
  try {
    const now = new Date();
    const rows = isNeon
      ? toRows(await executeQuery(`
          SELECT l.id::text AS loan_id,
                 l.user_id::text AS user_id,
                 l.book_id::text AS book_id,
                 COALESCE(l.due_date, l.due_at) AS due_at,
                 l.status,
                 u.email,
                 COALESCE(u.display_name, u.username, 'Pustara Reader') AS user_name,
                 b.title AS book_title
          FROM loans l
          JOIN users u ON u.id = l.user_id
          JOIN books b ON b.id = l.book_id
          WHERE l.returned_at IS NULL
            AND l.status IN ('active', 'extended', 'overdue')
        `))
      : toRows(await executeQuery(`
          SELECT CAST(l.id AS NVARCHAR(255)) AS loan_id,
                 CAST(l.user_id AS NVARCHAR(255)) AS user_id,
                 CAST(l.book_id AS NVARCHAR(255)) AS book_id,
                 COALESCE(l.due_date, l.due_at) AS due_at,
                 l.status,
                 u.email,
                 COALESCE(u.display_name, u.username, 'Pustara Reader') AS user_name,
                 b.title AS book_title
          FROM loans l
          JOIN users u ON u.id = l.user_id
          JOIN books b ON b.id = l.book_id
          WHERE l.returned_at IS NULL
            AND l.status IN ('active', 'extended', 'overdue')
        `));

    for (const loan of rows) {
      const dueAt = loan.due_at ? new Date(loan.due_at) : null;
      if (!dueAt || Number.isNaN(dueAt.getTime())) continue;

      const hoursLeft = (dueAt.getTime() - now.getTime()) / (1000 * 60 * 60);
      let stage = null;
      if (hoursLeft < 0) stage = 'overdue';
      else if (hoursLeft <= 24) stage = 'due_1d';
      else if (hoursLeft <= 72) stage = 'due_3d';

      if (!stage) continue;

      const dedupeKey = `mail:loan:${loan.loan_id}:${stage}`;
      const alreadySent = await safeRedisGet(dedupeKey);
      if (alreadySent) continue;

      if (stage === 'overdue' && String(loan.status || '').toLowerCase() !== 'overdue') {
        try {
          await executeQuery(
            isNeon
              ? `UPDATE loans SET status = 'overdue' WHERE id::text = $1`
              : `UPDATE loans SET status = 'overdue' WHERE CAST(id AS NVARCHAR(255)) = $1`,
            [String(loan.loan_id)]
          );
        } catch (_) {
          // keep processing reminder even if status update fails
        }
      }

      const stageTitle = stage === 'overdue'
        ? 'Peminjaman Terlambat'
        : stage === 'due_1d'
          ? 'Pengingat: Jatuh Tempo Besok'
          : 'Pengingat: 3 Hari Lagi';

      const stageBody = stage === 'overdue'
        ? `Buku \"${loan.book_title}\" sudah melewati tenggat. Mohon segera dikembalikan.`
        : stage === 'due_1d'
          ? `Buku \"${loan.book_title}\" akan jatuh tempo dalam 1 hari. Jangan lupa dikembalikan.`
          : `Buku \"${loan.book_title}\" akan jatuh tempo dalam 3 hari.`;

      await insertNotification({
        userId: String(loan.user_id),
        type: 'due',
        title: stageTitle,
        body: stageBody,
        bookId: String(loan.book_id),
      });

      await sendEmail({
        to: String(loan.email || ''),
        subject: `Pustara - ${stageTitle}`,
        text: [
          `Halo ${loan.user_name || 'Pustara Reader'},`,
          '',
          stageBody,
          '',
          `Tenggat: ${dueAt.toLocaleString('id-ID')}`,
          'Silakan buka Pustara untuk detail pinjaman.',
        ].join('\n'),
      }).catch((error) => {
        log('LOANS', `Email warning for ${loan.email}: ${error.message}`);
      });

      await safeRedisSet(dedupeKey, new Date().toISOString());
    }

    log('LOANS', `Processed ${rows.length} active loans.`);
  } catch (error) {
    log('LOANS', `❌ Error: ${error.message}`);
  }
}

async function autoReturnExpiredLoans() {
  log('LOANS', 'Auto-returning expired loans...');
  try {
    const expiredLoans = isNeon
      ? toRows(await executeQuery(`
          UPDATE loans l
          SET returned_at = CURRENT_TIMESTAMP,
              status = 'returned'
          FROM books b
          WHERE b.id = l.book_id
            AND l.returned_at IS NULL
            AND l.status IN ('active', 'extended', 'overdue')
            AND COALESCE(l.due_date, l.due_at) <= CURRENT_TIMESTAMP
          RETURNING l.id::text AS loan_id,
                    l.user_id::text AS user_id,
                    l.book_id::text AS book_id,
                    COALESCE(l.due_date, l.due_at) AS due_at,
                    b.title AS book_title
        `))
      : toRows(await executeQuery(`
          UPDATE l
          SET returned_at = GETDATE(),
              status = 'returned'
          OUTPUT CAST(inserted.id AS NVARCHAR(255)) AS loan_id,
                 CAST(inserted.user_id AS NVARCHAR(255)) AS user_id,
                 CAST(inserted.book_id AS NVARCHAR(255)) AS book_id,
                 COALESCE(inserted.due_date, inserted.due_at) AS due_at,
                 b.title AS book_title
          FROM loans l
          JOIN books b ON b.id = l.book_id
          WHERE l.returned_at IS NULL
            AND l.status IN ('active', 'extended', 'overdue')
            AND COALESCE(l.due_date, l.due_at) <= GETDATE()
        `));

    if (expiredLoans.length === 0) {
      log('LOANS', 'No expired loans to auto-return.');
      return;
    }

    for (const loan of expiredLoans) {
      try {
        await executeQuery(
          isNeon
            ? `UPDATE books
               SET available = LEAST(COALESCE(available, 0) + 1, COALESCE(total_stock, available + 1))
               WHERE id::text = $1`
            : `UPDATE books
               SET available = CASE
                 WHEN COALESCE(available, 0) + 1 > COALESCE(total_stock, available + 1)
                 THEN COALESCE(total_stock, available + 1)
                 ELSE COALESCE(available, 0) + 1
               END
               WHERE CAST(id AS NVARCHAR(255)) = $1`,
          [String(loan.book_id)]
        );

        await executeQuery(
          isNeon
            ? `UPDATE reading_sessions
               SET status = 'paused',
                   last_read_at = CURRENT_TIMESTAMP
               WHERE user_id::text = $1
                 AND book_id::text = $2
                 AND status IN ('reading', 'active')`
            : `UPDATE reading_sessions
               SET status = 'paused',
                   last_read_at = GETDATE()
               WHERE CAST(user_id AS NVARCHAR(255)) = $1
                 AND CAST(book_id AS NVARCHAR(255)) = $2
                 AND status IN ('reading', 'active')`,
          [String(loan.user_id), String(loan.book_id)]
        );

        await insertNotification({
          userId: String(loan.user_id),
          type: 'due',
          title: 'Akses Baca Berakhir',
          body: `Masa pinjam buku "${loan.book_title || 'Buku'}" sudah selesai, jadi akses bacanya otomatis ditutup. Kamu bisa meminjam ulang kalau ingin lanjut membaca.`,
          bookId: String(loan.book_id),
          data: {
            book_id: String(loan.book_id),
            loan_id: String(loan.loan_id),
            due_at: loan.due_at || null,
            action: 'reborrow',
          },
        });
      } catch (loanError) {
        log('LOANS', `Auto-return post-processing warning for ${loan.loan_id}: ${loanError.message}`);
      }
    }

    log('LOANS', `Auto-returned ${expiredLoans.length} expired loans.`);
  } catch (error) {
    log('LOANS', `Auto-return error: ${error.message}`);
  }
}

function makeSyntheticIdentity(firebaseUid) {
  const raw = String(firebaseUid || '').trim();
  const safe = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const base = (safe || 'user').slice(0, 24);
  const username = `u_${base}`;
  const email = `${base}@firebase.local`;
  return { username, email };
}

async function ensureUserFromFirebaseUid(firebaseUid) {
  if (!isNeon || !firebaseUid) return null;
  const { username, email } = makeSyntheticIdentity(firebaseUid);

  try {
    const created = await executeQuery(
      `INSERT INTO users (firebase_uid, username, display_name, email)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (firebase_uid) DO UPDATE SET updated_at = NOW()
       RETURNING id::text AS id`,
      [String(firebaseUid), username, username, email]
    );
    return created[0]?.id || null;
  } catch (e) {
    log('SYNC', `⚠️ ensureUserFromFirebaseUid failed for ${firebaseUid}: ${e.message}`);
    return null;
  }
}

function coerceArray(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.result)) return raw.result;
  if (Array.isArray(raw.entries)) return raw.entries;
  if (Array.isArray(raw.messages)) return raw.messages;
  if (Array.isArray(raw.data)) return raw.data;

  // Upstash xrange can return object map: { "<id>": { ...fields } }
  if (typeof raw === 'object') {
    const mapped = Object.entries(raw)
      .filter(([id, fields]) => typeof id === 'string' && fields && typeof fields === 'object')
      .map(([id, fields]) => [id, fields]);
    if (mapped.length > 0) return mapped;
  }

  return [];
}

function normalizeActivityRecord(record) {
  if (!record) return null;

  if (typeof record === 'string') {
    const parts = String(record).split(':');
    if (parts.length < 3) return null;
    const action = parts.pop();
    const bookRef = parts.pop();
    const userRef = parts.join(':');
    return { userRef, bookRef, action };
  }

  if (Array.isArray(record) && record.length >= 2) {
    const streamId = record[0] ? String(record[0]) : null;
    const fields = record[1] || {};
    return {
      streamId,
      userRef: fields.user_id || fields.userId,
      bookRef: fields.book_id || fields.bookId,
      action: fields.action,
    };
  }

  if (record && typeof record === 'object') {
    if (record.fields && typeof record.fields === 'object') {
      return {
        streamId: record.id ? String(record.id) : null,
        userRef: record.fields.user_id || record.fields.userId,
        bookRef: record.fields.book_id || record.fields.bookId,
        action: record.fields.action,
      };
    }

    return {
      userRef: record.user_id || record.userId || record.userRef,
      bookRef: record.book_id || record.bookId || record.bookRef,
      action: record.action,
    };
  }

  return null;
}

function parseStreamId(id) {
  const raw = String(id || '');
  const [msStr, seqStr = '0'] = raw.split('-');
  try {
    return { ms: BigInt(msStr), seq: BigInt(seqStr) };
  } catch {
    return null;
  }
}

function compareStreamIds(a, b) {
  const pa = parseStreamId(a);
  const pb = parseStreamId(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.ms < pb.ms) return -1;
  if (pa.ms > pb.ms) return 1;
  if (pa.seq < pb.seq) return -1;
  if (pa.seq > pb.seq) return 1;
  return 0;
}

async function resolveUserDbId(userRef) {
  if (!userRef) return null;
  const key = String(userRef).trim();
  if (USER_ID_CACHE.has(key)) return USER_ID_CACHE.get(key);

  try {
    const byId = await executeQuery('SELECT id::text AS id FROM users WHERE id::text = $1 LIMIT 1', [key]);
    if (byId.length > 0) {
      USER_ID_CACHE.set(key, byId[0].id);
      return byId[0].id;
    }

    const byFirebase = await executeQuery('SELECT id::text AS id FROM users WHERE firebase_uid = $1 LIMIT 1', [key]);
    if (byFirebase.length > 0) {
      USER_ID_CACHE.set(key, byFirebase[0].id);
      return byFirebase[0].id;
    }

    const autoCreated = await ensureUserFromFirebaseUid(key);
    if (autoCreated) {
      USER_ID_CACHE.set(key, autoCreated);
      return autoCreated;
    }
  } catch (e) {
    log('SYNC', `⚠️ resolveUserDbId failed for ${key}: ${e.message}`);
  }

  USER_ID_CACHE.set(key, null);
  return null;
}

async function resolveBookDbId(bookRef) {
  if (!bookRef) return null;
  const key = String(bookRef).trim();
  if (BOOK_ID_CACHE.has(key)) return BOOK_ID_CACHE.get(key);

  const normalizedSlug = key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  try {
    const byId = await executeQuery('SELECT id::text AS id FROM books WHERE id::text = $1 LIMIT 1', [key]);
    if (byId.length > 0) {
      BOOK_ID_CACHE.set(key, byId[0].id);
      return byId[0].id;
    }

    const byExternal = await executeQuery('SELECT id::text AS id FROM books WHERE lower(external_key) = lower($1) LIMIT 1', [key]);
    if (byExternal.length > 0) {
      BOOK_ID_CACHE.set(key, byExternal[0].id);
      return byExternal[0].id;
    }

    if (normalizedSlug && normalizedSlug !== key.toLowerCase()) {
      const bySlug = await executeQuery('SELECT id::text AS id FROM books WHERE lower(external_key) = lower($1) LIMIT 1', [normalizedSlug]);
      if (bySlug.length > 0) {
        BOOK_ID_CACHE.set(key, bySlug[0].id);
        return bySlug[0].id;
      }
    }

    const byTitle = await executeQuery('SELECT id::text AS id FROM books WHERE lower(title) = lower($1) LIMIT 1', [key]);
    if (byTitle.length > 0) {
      BOOK_ID_CACHE.set(key, byTitle[0].id);
      return byTitle[0].id;
    }
  } catch (e) {
    log('SYNC', `⚠️ resolveBookDbId failed for ${key}: ${e.message}`);
  }

  BOOK_ID_CACHE.set(key, null);
  return null;
}

// ─────────────────────────────────────────────────────────────
// Job 1: Rebuild AI Models — 03:00 WIB
// ─────────────────────────────────────────────────────────────
cron.schedule('0 3 * * *', async () => {
  log('REBUILD', 'Starting AI model rebuild process...');
  try {
    const reindexSecret = CRON_SECRET || 'PUSTARAbrakadaba23';
    const res = await fetch(`${FASTAPI_URL}/reindex`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${HF_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ secret: reindexSecret }),
      signal: AbortSignal.timeout(300000)
    });
    
    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
    const data = await res.json();
    
    await safeRedisSet('ai:last_rebuild_at', new Date().toISOString());
    await safeRedisSet('ai:last_rebuild_payload', JSON.stringify(data || {}));
    log('REBUILD', `✅ Success: ${JSON.stringify(data)}`);
  } catch (err) {
    log('REBUILD', `❌ Error: ${err.message}`);
  }
}, { timezone: 'Asia/Jakarta' });

// ─────────────────────────────────────────────────────────────
// Job 5: Due-date reminders + overdue status sync — every hour
// ─────────────────────────────────────────────────────────────
cron.schedule('15 * * * *', async () => {
  await autoReturnExpiredLoans();
  await sendLoanDeadlineReminders();
}, { timezone: 'Asia/Jakarta' });

// ─────────────────────────────────────────────────────────────
// Job 6: Community digest for new books/trending/AI updates — every 6 hours
// ─────────────────────────────────────────────────────────────
cron.schedule('30 */6 * * *', async () => {
  await sendCommunityDigestIfNeeded();
}, { timezone: 'Asia/Jakarta' });

// ─────────────────────────────────────────────────────────────
// Job 2: Refresh Trending — Every 6 hours
// ─────────────────────────────────────────────────────────────
cron.schedule('0 */6 * * *', async () => {
  log('TRENDING', 'Refreshing trending books...');
  try {
    const res = await fetch(`${FASTAPI_URL}/recommendations/trending?top_n=50`, {
      headers: { 'Authorization': `Bearer ${HF_TOKEN}` }
    });
    const data = await res.json();
    log('TRENDING', `✅ ${data.recommendations?.length || 0} trending books updated`);
  } catch (err) {
    log('TRENDING', `❌ Error: ${err.message}`);
  }
}, { timezone: 'Asia/Jakarta' });

// ─────────────────────────────────────────────────────────────
// Job 3: Sync Redis activity → Neon/Azure — every 6 hours
// ─────────────────────────────────────────────────────────────
cron.schedule('0 */6 * * *', async () => {
  log('SYNC', 'Synchronize Redis scores to Database...');
  try {
    let activities = [];
    const keyType = await redis.type('activity:stream');
    let streamLastSeenId = null;
    if (keyType === 'list') {
      activities = coerceArray(await redis.lrange('activity:stream', 0, -1));
    } else if (keyType === 'stream') {
      activities = coerceArray(await redis.xrange('activity:stream', '-', '+'));
      const cursorBefore = await redis.get(STREAM_CURSOR_KEY);
      if (cursorBefore) {
        activities = activities.filter((entry) => {
          const streamId = Array.isArray(entry) ? entry[0] : entry?.id;
          if (!streamId) return false;
          return compareStreamIds(streamId, cursorBefore) > 0;
        });
      }
    }

    log('SYNC', `Found ${activities.length} activity records in stream`);

    if (!activities || activities.length === 0) {
      return;
    }

    let synced = 0;
    let skipped = 0;
    let hasError = false;
    // Set time function based on DB type
    const timeFunc = isNeon ? 'NOW()' : 'GETDATE()';

    const ACTION_WEIGHTS = { view: 1, read: 3, like: 5, bookmark: 4, wishlist: 4, share: 2, review: 8, search_intent: 1 };

    for (const raw of activities) {
      const normalized = normalizeActivityRecord(raw);
      if (!normalized || !normalized.userRef || !normalized.bookRef || !normalized.action) {
        skipped++;
        continue;
      }

      if (keyType === 'stream' && normalized.streamId) {
        if (!streamLastSeenId || compareStreamIds(normalized.streamId, streamLastSeenId) > 0) {
          streamLastSeenId = normalized.streamId;
        }
      }

      const action = String(normalized.action);
      const bookRef = String(normalized.bookRef);
      const userRef = String(normalized.userRef);
      const score = ACTION_WEIGHTS[action] || 1;

      const userId = await resolveUserDbId(userRef);
      const bookId = await resolveBookDbId(bookRef);

      if (!userId || !bookId) {
        skipped++;
        continue;
      }

      const viewInc = action === 'view' ? 1 : 0;
      const readInc = action === 'read' ? 1 : 0;
      const likeInc = action === 'like' ? 1 : 0;
      const bookmarkInc = action === 'bookmark' || action === 'wishlist' ? 1 : 0;
      const shareInc = action === 'share' ? 1 : 0;
      const reviewInc = action === 'review' ? 1 : 0;

      try {
        await executeQuery(
          `INSERT INTO user_book_scores
              (user_id, book_id, score, views, reads, likes, bookmarks, shares, review_cnt, updated_at)
           VALUES
              ($1, $2, $3, $4, $5, $6, $7, $8, $9, ${timeFunc})
           ON CONFLICT (user_id, book_id) DO UPDATE
           SET
             score = user_book_scores.score + EXCLUDED.score,
             views = COALESCE(user_book_scores.views, 0) + EXCLUDED.views,
             reads = COALESCE(user_book_scores.reads, 0) + EXCLUDED.reads,
             likes = COALESCE(user_book_scores.likes, 0) + EXCLUDED.likes,
             bookmarks = COALESCE(user_book_scores.bookmarks, 0) + EXCLUDED.bookmarks,
             shares = COALESCE(user_book_scores.shares, 0) + EXCLUDED.shares,
             review_cnt = COALESCE(user_book_scores.review_cnt, 0) + EXCLUDED.review_cnt,
             updated_at = ${timeFunc}`,
          [userId, bookId, score, viewInc, readInc, likeInc, bookmarkInc, shareInc, reviewInc]
        );
        synced++;
      } catch (dbErr) {
        skipped++;
        hasError = true;
      }
    }

    if (keyType === 'stream' && streamLastSeenId && !hasError) {
      await redis.set(STREAM_CURSOR_KEY, streamLastSeenId);
    }

    if (keyType === 'list' && synced > 0 && skipped === 0) {
      await redis.del('activity:stream');
    }

    log('SYNC', `✅ Successfully synced ${synced} records to the Database, skipped ${skipped}`);
  } catch (err) {
    log('SYNC', `❌ Synchronization failed: ${err.message}`);
  }
}, { timezone: 'Asia/Jakarta' });

// ─────────────────────────────────────────────────────────────
// Job 4: Overdue Loan Check — every hour (to be implemented)
// ─────────────────────────────────────────────────────────────
/*
cron.schedule('0 * * * *', async () => {
  log('LOANS', 'Checking overdue loans...');
  const timeFunc = isNeon ? 'NOW()' : 'GETDATE()';
  try {
    const updated = await executeQuery(`
      UPDATE loans SET status = 'overdue'
      WHERE status = 'active' AND due_at < ${timeFunc}
    `);
    if (updated.length > 0) log('LOANS', `⚠️ ${updated.length} loan marked overdue`);
  } catch (err) {
    log('LOANS', `❌ Error: ${err.message}`);
  }
}, { timezone: 'Asia/Jakarta' });
*/

log('INIT', '🚀 All Pustara Cron Job systems are active!');

module.exports = {};
