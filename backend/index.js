/**
 * Pustara Backend Server
 *
 * Express.js server dengan Firebase Authentication
 *
 * Architecture:
 * - config/     : Firebase initialization
 * - providers/  : Auth provider abstraction (Firebase, Azure, etc)
 * - services/   : Business logic layer
 * - middleware/ : Express middleware
 * - routes/     : API routes
 */

// CRITICAL: Polyfill global crypto for @typespec/ts-http-runtime
if (typeof global.crypto === 'undefined') {
  global.crypto = require('crypto').webcrypto;
}

require("dotenv").config();

const nodeEnv = (process.env.NODE_ENV || '').toLowerCase();
const isNeonMode = nodeEnv === 'neon' || process.env.NEON_CLOUD_MODE === 'true';
const dbType = isNeonMode ? 'Neon PostgreSQL (Production Cloud)' : 'Azure SQL';
const aiUrl = process.env.FASTAPI_URL || 'http://localhost:8001';

console.log("🔥 DEBUG URL:", aiUrl);
console.log(`📊 Database Mode: ${isNeonMode ? 'NEON PRODUCTION CLOUD' : 'PRODUCTION (Azure SQL)'}`);
console.log(`🔐 NODE_ENV: ${process.env.NODE_ENV || 'not set'}`);

const express = require("express");
const cors = require("cors");
const fileUpload = require("express-fileupload");
const CONFIG = require("./constants/config");
const FirebaseProvider = require("./providers/firebaseProvider");
const AuthService = require("./services/authService");
const { createVerifyTokenMiddleware, createOptionalVerifyTokenMiddleware } = require("./middleware/auth");
const { createCheckActiveSessionMiddleware } = require("./middleware/checkActiveSession");
const { authorizeAdmin } = require("./middleware/adminAuth");
const { createAuthRoutes } = require("./routes/auth");
const createSurveyRoutes = require("./routes/survey");
const {
  initializeDatabase,
  ensureNeonShelfSchemaCompatibility,
  ensureNeonUsersSchemaCompatibility,
  createLoginEventsTable,
  createUsersTable,
  createUserSurveyTable,
  getPool
} = require("./config/database");

// Routes
const createRecommendationsRoutes = require('./routes/recommendations');
const booksRoutes = require('./routes/booksRoutes');
const booksAdminRoutes = require('./routes/booksAdminRoutes');
const adminRoutes = require('./routes/adminRoutes');
const readingSessionRoutes = require('./routes/readingSessionRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');
const userRoutes = require('./routes/userRoutes');
const shelfRoutes = require('./routes/shelfRoutes');
const feedRoutes = require('./routes/feedRoutes');
const reviewsRoutes = require('./routes/reviewsRoutes');

require('./jobs/cron'); //init cron jobs for ai-related tasks

// ==========================================
// INITIALIZE
// ==========================================
const app = express();

// NOTE: Use the `cors` middleware below to handle preflight and origin reflection.
// Avoid setting Access-Control-Allow-* headers manually here because it may
// conflict with `cors` and return a wildcard origin while also allowing
// credentials, which browsers will reject during preflight.

// Middleware
app.use(express.json());
app.use(fileUpload({
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  abortOnLimit: true,
  responseOnLimit: 'File size too large (max 50MB)',
  useTempFiles: true,
  tempFileDir: '/tmp/',
}));

// ==========================================
// CORS SETUP - CRITICAL FOR VERCEL FRONTEND
// ==========================================
// Use a dynamic origin checker so the cors middleware will reflect the
// actual requesting Origin when credentials are allowed. Also include
// custom device headers used by the frontend (x-device-id, etc.) so
// preflight responses include them in Access-Control-Allow-Headers.
const corsOriginCallback = (origin, callback) => {
  // Allow requests with no origin (mobile/native, curl, server-to-server)
  if (!origin) {
    console.log("✅ CORS: No origin header (likely mobile/native/internal)");
    return callback(null, true);
  }
  
  try {
    const allowed = Array.isArray(CONFIG.CORS_ORIGINS)
      ? CONFIG.CORS_ORIGINS
      : [CONFIG.CORS_ORIGINS];
    
    if (allowed.indexOf(origin) !== -1) {
      console.log(`✅ CORS: Origin allowed: ${origin}`);
      return callback(null, true);
    }
    
    console.warn(`❌ CORS: Origin NOT allowed: ${origin}`);
    console.warn(`📋 Allowed origins: ${allowed.join(", ")}`);
  } catch (e) {
    console.error("❌ CORS: Origin check error:", e.message);
  }
  
  return callback(new Error('Not allowed by CORS'));
};

app.use(cors({
  origin: corsOriginCallback,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "x-device-id",
    "x-device-name",
    "x-device-os",
    "x-device-browser",
  ],
  exposedHeaders: [
    "Content-Type",
    "X-Total-Count",  // For pagination
    "X-Page-Number",
    "X-Page-Size",
  ],
  credentials: true,
  optionsSuccessStatus: 200,
}));

// Setup Auth
const authProvider = new FirebaseProvider();
const authService = new AuthService(authProvider);
const verifyTokenMiddleware = createVerifyTokenMiddleware(authService);
const optionalVerifyTokenMiddleware = createOptionalVerifyTokenMiddleware(authService);
const checkActiveSessionMiddleware = createCheckActiveSessionMiddleware();

// ==========================================
// ROUTES
// ==========================================

// Health Check
app.get("/", (req, res) => {
  res.json({ message: "Pustara API ready", status: "healthy" });
});

// Auth Routes
app.use("/auth", createAuthRoutes(authService, verifyTokenMiddleware, checkActiveSessionMiddleware));

// Survey Routes
app.use("/survey", createSurveyRoutes(verifyTokenMiddleware));

// Protected Route Example
app.get("/api/protected", verifyTokenMiddleware, (req, res) => {
  res.json({ message: "Protected data", user: req.user });
});

// Recommendations Routes
app.use('/recommendations', createRecommendationsRoutes(verifyTokenMiddleware, optionalVerifyTokenMiddleware));

// Books Admin Routes (protected by verifyToken + authorizeAdmin)
// IMPORTANT: Mount to /admin prefix to avoid catching all / routes
// app.use('/', verifyTokenMiddleware, authorizeAdmin, booksAdminRoutes);

app.use('/admin/books', verifyTokenMiddleware, checkActiveSessionMiddleware, authorizeAdmin, booksAdminRoutes);

// Books Routes (public catalog + token-aware protected reader endpoints)
app.use('/', optionalVerifyTokenMiddleware, booksRoutes);

app.use('/admin', verifyTokenMiddleware, checkActiveSessionMiddleware, authorizeAdmin, adminRoutes);

// User Management Admin Routes (protected by verifyToken + authorizeAdmin)
// NOTE: Do not mount adminRoutes at root ('/'), it can hijack '/users/*' endpoints
// such as '/users/username-availability' and incorrectly require admin auth.
// Keep admin routes under '/admin' only.

// Reading Session Routes (track user reading progress)
app.use('/reading', verifyTokenMiddleware, checkActiveSessionMiddleware, readingSessionRoutes);

// Shelf Routes (loans, reading sessions, wishlist)
app.use('/shelf', verifyTokenMiddleware, checkActiveSessionMiddleware, shelfRoutes);

// Feed Routes (activity, notifications, recommendations)
app.use('/feed', verifyTokenMiddleware, checkActiveSessionMiddleware, feedRoutes);

// Public Reviews (recent community reviews for homepage widgets)
app.use('/reviews', optionalVerifyTokenMiddleware, reviewsRoutes);

// Also mount reviews routes under /community so front-end can request /community/reviews
app.use('/community', optionalVerifyTokenMiddleware, reviewsRoutes);

// User Social/Profile Routes (allow optional auth for actor-aware responses)
app.use('/users', optionalVerifyTokenMiddleware, userRoutes);

// Analytics Routes (stats & dashboard)
app.use('/stats', analyticsRoutes);

// Cron Routes
app.use('/cron', require('./routes/cronRoutes'));

// ==========================================
// ERROR HANDLING
// ==========================================
app.use((err, req, res, next) => {
  console.error("Error:", err.message);
  res.status(500).json({ success: false, error: CONFIG.ERRORS.INTERNAL_SERVER_ERROR });
});

// ==========================================
// START SERVER
// ==========================================
async function startServer() {
  let dbConnected = false;
  
  try {
    console.log("\n⏳ Initializing Database...");
    await initializeDatabase();
    try {
      await ensureNeonShelfSchemaCompatibility();
    } catch (schemaError) {
      console.warn(`⚠️  Shelf schema compatibility check skipped: ${schemaError.message}`);
    }
    try {
      await ensureNeonUsersSchemaCompatibility();
    } catch (schemaError) {
      console.warn(`⚠️  Users schema compatibility check skipped: ${schemaError.message}`);
    }
    try {
      await createLoginEventsTable();
    } catch (loginSchemaError) {
      console.warn(`⚠️  Login events schema check skipped: ${loginSchemaError.message}`);
    }

    try {
      const pool = getPool();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS review_likes (
          review_id   UUID NOT NULL,
          user_id     TEXT NOT NULL,
          created_at  TIMESTAMPTZ DEFAULT now(),
          PRIMARY KEY (review_id, user_id)
        )
      `);
    } catch (e) {
      console.warn('⚠️  review_likes table check skipped:', e.message);
    }
    console.log("✅ Database initialized successfully\n");
    
    await createUsersTable();
    const surveyTableReady = await createUserSurveyTable();
    dbConnected = true;
  } catch (dbError) {
    console.warn("\n⚠️  Database initialization failed (running in offline mode):");
    console.warn(`   ${dbError.message}`);
    console.warn("   You can still use the API with limited functionality\n");
  }
  
  // Start server even if DB failed
  app.listen(CONFIG.PORT, async () => {
    console.log(`${CONFIG.MESSAGES.SERVER_RUNNING} ${CONFIG.PORT}`);
    console.log(`Environment: ${CONFIG.NODE_ENV}`);
    console.log(`Auth: Firebase`);
    console.log(`📊 Database: ${dbType} ${dbConnected ? '✅' : '⚠️ OFFLINE'}`);

    // Auto-reindex PustarAI (optional, don't crash if fails)
    console.log("\n🤖 Attempting to initialize PustarAI...");
    try {
      const cronSecret = process.env.CRON_SECRET || process.env.RI_SECRET || 'PUSTARAbrakadaba23';

      const reindexRes = await fetch(`${aiUrl}/reindex`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ secret: cronSecret }),
      });
      
      if (reindexRes.ok) {
        console.log("✅ PustarAI successfully reindexed and is ready!");
      } else {
        console.log(`⚠️  PustarAI reindex returned status ${reindexRes.status} - may still work`);
      }
    } catch (err) {
      console.warn(`⚠️  Could not contact PustarAI: ${err.message}\n    (This is OK if you're offline or AI not needed yet)`);
    }
  });
}

startServer();
