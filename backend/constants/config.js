/**
 * Application Configuration Constants
 */

const CONFIG = {
  // Server
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || "development",

  // CORS
  CORS_ORIGINS: Array.from(new Set([
    ...(process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(",").map(origin => origin.trim())
      : ["http://localhost:3000", "http://localhost:3001"]),
    "https://pustara.vercel.app",
    "https://pustara-deployfe.vercel.app",  // ✅ Frontend Vercel deployment
  ])),
    
  // Firebase
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
  FIREBASE_API_KEY: process.env.FIREBASE_API_KEY,

  // Auth
  TOKEN_BEARER_PREFIX: "Bearer",
  MIN_PASSWORD_LENGTH: 6,

  // Rate Limiting
  RATE_LIMIT: {
    // Public routes (auth): IP-based, lenient to avoid campus NAT blocks
    AUTH: {
      window: 15 * 60, // 15 minutes
      max: 20, // 20 requests per 15 min = ~1.3 req/min
    },
    // Protected routes: User ID-based, strict per-user
    AI_CHAT: {
      window: 60, // 1 minute
      max: 10, // 10 requests per minute
    },
    ACTIVITY: {
      window: 60, // 1 minute
      max: 30, // 30 requests per minute (book interactions)
    },
    BOOK_FETCH: {
      window: 60, // 1 minute
      max: 50, // 50 requests per minute (cover art, metadata)
    },
  },

  // Messages
  MESSAGES: {
    SERVER_RUNNING: "✅ Server running on port",
    FIREBASE_INITIALIZED: "🔐 Firebase Admin SDK initialized",
    TOKEN_VERIFIED: "✅ Token verified successfully",
    USER_CREATED: "User created successfully",
    LOGIN_SUCCESS: "Login successful",
    LOGOUT_SUCCESS: "Logged out successfully",
  },

  // Errors
  ERRORS: {
    NO_TOKEN: "No token provided in Authorization header",
    INVALID_TOKEN_FORMAT: "Invalid token format",
    TOKEN_VERIFICATION_FAILED: "Token verification failed",
    CAPTCHA_REQUIRED: "CAPTCHA token is required",
    CAPTCHA_FAILED: "CAPTCHA verification failed",
    EMAIL_PASSWORD_REQUIRED: "Email and password are required",
    PASSWORD_TOO_SHORT: `Password must be at least ${6} characters`,
    INTERNAL_SERVER_ERROR: "Internal server error",
  },
};

module.exports = CONFIG;
