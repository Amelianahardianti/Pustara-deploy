/**
 * Database Configuration & Connection Manager
 * * NODE_ENV=neon or NEON_CLOUD_MODE=true → Neon PostgreSQL (pg)
 * NODE_ENV=* → Azure SQL (mssql) — production
 */

const nodeEnv = (process.env.NODE_ENV || '').toLowerCase();
const isNeon = nodeEnv === 'neon' || process.env.NEON_CLOUD_MODE === 'true';

// ── 1. Neon / PostgreSQL (Production Cloud Mode) ──────────────────────────────
let pgPool = null;

async function initNeon() {
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'dummy' ? false : { rejectUnauthorized: false },
  });

  // Force every connection to use the public schema.
  // Neon sometimes resets the default search_path, causing "relation does not exist".
  pgPool.on('connect', (client) => {
    client.query('SET search_path TO public').catch((err) => {
      console.warn('[DB] Failed to set search_path:', err.message);
    });
  });
  
  // Test connection
  const client = await pgPool.connect();
  await client.query('SET search_path TO public');
  client.release();
  console.log('✅ Neon PostgreSQL connected (Production Cloud)');
  return pgPool;
}

// ── 2. Azure SQL (Production Mode) ────────────────────────────────────────────
const sql = isNeon ? null : require('mssql');

const azureConfig = isNeon ? null : {
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  authentication: {
    type: 'default',
    options: {
      userName: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    },
  },
  options: {
    encrypt: true,
    trustServerCertificate: false,
    connectTimeout: 30000,
    requestTimeout: 30000,
  },
};

let azurePool = null;

async function initAzure() {
  if (!azurePool) {
    azurePool = new sql.ConnectionPool(azureConfig);
    await azurePool.connect();
    console.log('✅ Azure SQL Database connected (production)');
  }
  return azurePool;
}

// ── 3. Unified API ────────────────────────────────────────────────────────────

/**
* Initialize DB based on the environment
*/
async function initializeDatabase() {
  try {
    if (isNeon) {
      return await initNeon();
    }
    return await initAzure();
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    throw error;
  }
}

/**
 * Neon-only schema compatibility patcher.
 * Keeps shelf endpoints stable even when production schema drifts
 * (e.g. created_at vs added_at, due_at vs due_date).
 */
async function ensureNeonShelfSchemaCompatibility() {
  if (!isNeon) return;
  if (!pgPool) throw new Error('Neon DB not initialized. Call initializeDatabase() first');

  const safeStatements = [
    "ALTER TABLE IF EXISTS wishlist ADD COLUMN IF NOT EXISTS added_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
    "ALTER TABLE IF EXISTS loans ADD COLUMN IF NOT EXISTS borrowed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
    "ALTER TABLE IF EXISTS loans ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP + INTERVAL '7 days'",
    "ALTER TABLE IF EXISTS loans ADD COLUMN IF NOT EXISTS due_date TIMESTAMPTZ",
    "ALTER TABLE IF EXISTS loans ADD COLUMN IF NOT EXISTS returned_at TIMESTAMPTZ",
    "ALTER TABLE IF EXISTS loans ADD COLUMN IF NOT EXISTS extended BOOLEAN DEFAULT false",
    "ALTER TABLE IF EXISTS loans ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'",
    "ALTER TABLE IF EXISTS reading_sessions ADD COLUMN IF NOT EXISTS status TEXT",
    "ALTER TABLE IF EXISTS reading_sessions ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
    "ALTER TABLE IF EXISTS reading_sessions ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ",
    "ALTER TABLE IF EXISTS reading_sessions ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ",
    "ALTER TABLE IF EXISTS reading_sessions ADD COLUMN IF NOT EXISTS progress_percentage NUMERIC DEFAULT 0",
    "ALTER TABLE IF EXISTS reading_sessions ADD COLUMN IF NOT EXISTS current_page INTEGER DEFAULT 0",
    "ALTER TABLE IF EXISTS reading_sessions ADD COLUMN IF NOT EXISTS total_pages INTEGER DEFAULT 0",
    "ALTER TABLE IF EXISTS reading_sessions ADD COLUMN IF NOT EXISTS reading_time_minutes INTEGER DEFAULT 0",
    "CREATE TABLE IF NOT EXISTS login_events (id BIGSERIAL PRIMARY KEY, firebase_uid TEXT NOT NULL, login_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)",
    "ALTER TABLE IF EXISTS notifications ADD COLUMN IF NOT EXISTS body TEXT",
    "ALTER TABLE IF EXISTS notifications ADD COLUMN IF NOT EXISTS book_id UUID",
    "ALTER TABLE IF EXISTS notifications ADD COLUMN IF NOT EXISTS actor_id UUID",
    "ALTER TABLE IF EXISTS notifications ADD COLUMN IF NOT EXISTS read BOOLEAN DEFAULT false",
    "ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active'",
    "CREATE INDEX IF NOT EXISTS idx_users_status ON users(status)",
    "ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS activity_visible BOOLEAN DEFAULT true",
    "ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS public_reading_list BOOLEAN DEFAULT true",
    "ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS public_reviews BOOLEAN DEFAULT true",
    "ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS public_followers BOOLEAN DEFAULT true",
    "ALTER TABLE IF EXISTS user_book_scores ADD COLUMN IF NOT EXISTS views INTEGER DEFAULT 0",
    "ALTER TABLE IF EXISTS user_book_scores ADD COLUMN IF NOT EXISTS reads INTEGER DEFAULT 0",
    "ALTER TABLE IF EXISTS user_book_scores ADD COLUMN IF NOT EXISTS likes INTEGER DEFAULT 0",
    "ALTER TABLE IF EXISTS user_book_scores ADD COLUMN IF NOT EXISTS bookmarks INTEGER DEFAULT 0",
    "ALTER TABLE IF EXISTS user_book_scores ADD COLUMN IF NOT EXISTS shares INTEGER DEFAULT 0",
    "ALTER TABLE IF EXISTS user_book_scores ADD COLUMN IF NOT EXISTS review_cnt INTEGER DEFAULT 0",
    "ALTER TABLE IF EXISTS user_book_scores ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
    `CREATE TABLE IF NOT EXISTS review_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      review_id UUID NOT NULL,
      reporter_id UUID,
      reason VARCHAR(100) DEFAULT 'Spam',
      status VARCHAR(50) DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      resolved_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_review_reports_status ON review_reports(status)`,
    "ALTER TABLE IF EXISTS reviews ADD COLUMN IF NOT EXISTS review_text TEXT",
    "UPDATE reviews SET review_text = body WHERE review_text IS NULL AND body IS NOT NULL",
    "ALTER TABLE IF EXISTS reviews ADD COLUMN IF NOT EXISTS body TEXT",
    "UPDATE reviews SET body = review_text WHERE body IS NULL AND review_text IS NOT NULL",
    "ALTER TABLE IF EXISTS reviews ADD COLUMN IF NOT EXISTS likes INTEGER DEFAULT 0",
  ];

  for (const statement of safeStatements) {
    try {
      await pgPool.query(statement);
    } catch (error) {
      console.warn(`⚠️  Schema compatibility statement skipped: ${error.message}`);
    }
  }

  const backfillBlocks = [
    `DO $$
     BEGIN
       IF EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'wishlist' AND column_name = 'created_at'
       ) THEN
         UPDATE wishlist
         SET added_at = COALESCE(added_at, created_at)
         WHERE added_at IS NULL;
       END IF;
     END $$;`,
    `DO $$
     BEGIN
       IF EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'loans' AND column_name = 'due_at'
       ) THEN
         UPDATE loans
         SET due_date = COALESCE(due_date, due_at)
         WHERE due_date IS NULL;
       END IF;
     END $$;`,
    `DO $$
     BEGIN
       IF EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'loans' AND column_name = 'due_date'
       ) THEN
         UPDATE loans
         SET due_at = COALESCE(due_at, due_date)
         WHERE due_at IS NULL;
       END IF;
     END $$;`,
    `DO $$
     BEGIN
       IF EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'loans' AND column_name = 'created_at'
       ) THEN
         UPDATE loans
         SET borrowed_at = COALESCE(borrowed_at, created_at)
         WHERE borrowed_at IS NULL;
       END IF;
     END $$;`,
    `DO $$
     BEGIN
       IF EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'reading_sessions' AND column_name = 'start_time'
       ) THEN
         UPDATE reading_sessions
         SET started_at = COALESCE(started_at, start_time)
         WHERE started_at IS NULL;
       END IF;
     END $$;`,
    `DO $$
     BEGIN
       IF EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'reading_sessions' AND column_name = 'pages_read'
       ) THEN
         UPDATE reading_sessions
         SET current_page = COALESCE(current_page, pages_read)
         WHERE current_page IS NULL OR current_page = 0;
       END IF;
     END $$;`,
    `DO $$
     BEGIN
       IF EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'reading_sessions' AND column_name = 'duration_minutes'
       ) THEN
         UPDATE reading_sessions
         SET reading_time_minutes = COALESCE(reading_time_minutes, duration_minutes)
         WHERE reading_time_minutes IS NULL OR reading_time_minutes = 0;
       END IF;
     END $$;`,
    `UPDATE reading_sessions SET status = COALESCE(status, 'reading') WHERE status IS NULL`,
    `UPDATE notifications SET body = COALESCE(body, message) WHERE body IS NULL`,
    `UPDATE notifications SET read = COALESCE(read, is_read, false) WHERE read IS NULL`,
  ];

  for (const statement of backfillBlocks) {
    try {
      await pgPool.query(statement);
    } catch (error) {
      console.warn(`⚠️  Schema compatibility backfill skipped: ${error.message}`);
    }
  }

  console.log('✅ Neon shelf schema compatibility ensured');
}

/**
* Execute query — Abstraction so the service layer doesn't need to know which DB
* Neon: uses $1, $2, ... placeholders
* Azure: automatically converted to @p1, @p2, ...
* Also converts PostgreSQL syntax to T-SQL syntax
*/
async function executeQuery(query, params = []) {
  if (isNeon) {
    if (!pgPool) throw new Error('Neon DB not initialized. Call initializeDatabase() first');
    const result = await pgPool.query(query, params);
    return result.rows;
  }

  // Azure SQL logic
  if (!azurePool) throw new Error('Azure DB not initialized. Call initializeDatabase() first');
  
  let azureQuery = query;
  const request = azurePool.request();

  // Convert placeholders: $1, $2 → @p1, @p2
  params.forEach((val, i) => {
    const paramRegex = new RegExp(`\\$${i + 1}\\b`, 'g');
    azureQuery = azureQuery.replace(paramRegex, `@p${i + 1}`);
    request.input(`p${i + 1}`, val);
  });

  // Convert PostgreSQL syntax to T-SQL syntax
  
  // 1. Convert true/false literals to 1/0
  azureQuery = azureQuery.replace(/\btrue\b/gi, '1');
  azureQuery = azureQuery.replace(/\bfalse\b/gi, '0');
  
  // 2. Convert @pN = ANY(column) to CHARINDEX for JSON arrays
  // Handles: @p1 = ANY(genres), @p2 = ANY(authors) etc
  azureQuery = azureQuery.replace(
    /@p(\d+)\s*=\s*ANY\s*\((\w+)\)/gi,
    (match, paramNum, columnName) => {
      return `CHARINDEX('\"' + @p${paramNum} + '\"', ${columnName}) > 0`;
    }
  );
  
  // 3. Convert LIMIT x OFFSET y to OFFSET y ROWS FETCH NEXT x ROWS ONLY
  // Pattern: LIMIT @pN [OFFSET @pM]
  azureQuery = azureQuery.replace(
    /LIMIT\s+@p(\d+)(?:\s+OFFSET\s+@p(\d+))?/gi,
    (match, limitParam, offsetParam) => {
      if (offsetParam) {
        return `OFFSET @p${offsetParam} ROWS FETCH NEXT @p${limitParam} ROWS ONLY`;
      } else {
        return `OFFSET 0 ROWS FETCH NEXT @p${limitParam} ROWS ONLY`;
      }
    }
  );
  
  // 4. Convert ILIKE to LIKE for case-insensitive search
  azureQuery = azureQuery.replace(/\bILIKE\b/gi, 'LIKE');
  
  const result = await request.query(azureQuery);
  
  // Return in same format as pg library for compatibility
  // Controllers expect result.rows, but mssql uses result.recordset
  return { rows: result.recordset };
}

/**
 * Get raw pool (for cases that require manual transactions)
 */
function getPool() {
  if (isNeon) {
    if (!pgPool) throw new Error('Neon DB not initialized');
    return pgPool;
  }
  if (!azurePool) throw new Error('Azure DB not initialized');
  return azurePool;
}

// ── 4. Bootstrapping Table ────────────────────────────────────────────────────

async function createUsersTable() {
  if (isNeon) {
    console.log('✅ Users table — auto-create di-skip untuk Neon (pakai schema.sql)');
    return;
  }
  
  try {
    const pool = getPool();
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'Users')
      BEGIN
        CREATE TABLE Users (
          id INT PRIMARY KEY IDENTITY(1,1),
          uid NVARCHAR(255) UNIQUE NOT NULL,
          email NVARCHAR(255) UNIQUE NOT NULL,
          displayName NVARCHAR(255),
          photoURL NVARCHAR(MAX),
          role NVARCHAR(50) DEFAULT 'reader',
          status NVARCHAR(50) DEFAULT 'active',
          createdAt DATETIME DEFAULT GETDATE(),
          updatedAt DATETIME DEFAULT GETDATE()
        );
        CREATE INDEX idx_email ON Users(email);
        CREATE INDEX idx_uid ON Users(uid);
        CREATE INDEX idx_role ON Users(role);
        PRINT 'Users table created';
      END
      ELSE
      BEGIN
        IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'Users' AND COLUMN_NAME = 'role')
        BEGIN
          ALTER TABLE Users ADD role NVARCHAR(50) DEFAULT 'reader';
          CREATE INDEX idx_role ON Users(role);
          PRINT 'Added role column to Users table';
        END

        IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'Users' AND COLUMN_NAME = 'status')
        BEGIN
          ALTER TABLE Users ADD status NVARCHAR(50) DEFAULT 'active';
          CREATE INDEX idx_status ON Users(status);
          PRINT 'Added status column to Users table';
        END
      END
    `);
    console.log('✅ Users table ready');
  } catch (error) {
    console.error('❌ Error creating users table:', error);
    throw error;
  }
}

/**
 * Neon-only users schema compatibility patcher.
 * Adds admin-facing fields that may be missing from older deployments.
 */
async function ensureNeonUsersSchemaCompatibility() {
  if (!isNeon) return;
  if (!pgPool) throw new Error('Neon DB not initialized. Call initializeDatabase() first');

  const statements = [
    "ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active'",
    "CREATE INDEX IF NOT EXISTS idx_users_status ON users(status)",
  ];

  for (const statement of statements) {
    try {
      await pgPool.query(statement);
    } catch (error) {
      console.warn(`⚠️  Users schema compatibility statement skipped: ${error.message}`);
    }
  }
}

async function createLoginEventsTable() {
  if (isNeon) {
    console.log('✅ Login events table — auto-create di-skip untuk Neon (pakai schema/runtime)');
    return;
  }

  try {
    const pool = getPool();
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'login_events')
      BEGIN
        CREATE TABLE login_events (
          id INT PRIMARY KEY IDENTITY(1,1),
          firebase_uid NVARCHAR(255) NOT NULL,
          login_at DATETIME2 DEFAULT GETDATE()
        );
        CREATE INDEX idx_login_events_firebase_uid ON login_events(firebase_uid);
        CREATE INDEX idx_login_events_login_at ON login_events(login_at);
        PRINT 'login_events table created';
      END
    `);
    console.log('✅ login_events table ready');
  } catch (error) {
    console.error('❌ Error creating login_events table:', error);
    throw error;
  }
}

async function createUserSurveyTable() {
  if (isNeon) {
    console.log('✅ UserSurvey — auto-create di-skip untuk Neon');
    return;
  }
  
  try {
    const pool = getPool();
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'UserSurvey')
      BEGIN
        CREATE TABLE UserSurvey (
          id INT PRIMARY KEY IDENTITY(1,1),
          userId INT NOT NULL,
          favoriteGenre NVARCHAR(100),
          age NVARCHAR(50),
          gender NVARCHAR(50),
          createdAt DATETIME DEFAULT GETDATE(),
          updatedAt DATETIME DEFAULT GETDATE(),
          FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_userId ON UserSurvey(userId);
        PRINT 'UserSurvey table created';
      END
    `);
    console.log('✅ UserSurvey table ready');
  } catch (error) {
    console.error('❌ Error creating survey table:', error);
    throw error;
  }
}

async function closeDatabase() {
  if (isNeon && pgPool) {
    await pgPool.end();
    pgPool = null;
    console.log('Neon Database connection closed');
  } else if (azurePool) {
    await azurePool.close();
    azurePool = null;
    console.log('Azure Database connection closed');
  }
}

module.exports = {
  initializeDatabase,
  ensureNeonShelfSchemaCompatibility,
  ensureNeonUsersSchemaCompatibility,
  executeQuery,
  getPool,
  createUsersTable,
  createLoginEventsTable,
  createUserSurveyTable,
  closeDatabase,
  isNeon,
};
