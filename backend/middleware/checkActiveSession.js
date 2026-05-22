/**
 * Active Session Validation Middleware
 *
 * Checks if user's session has been revoked.
 * Must be placed AFTER verifyTokenMiddleware (requires req.user.uid).
 *
 * Checks the most recent session for the user:
 * - If revoked = true: return 401 SESSION_REVOKED (multi-device logout)
 * - If revoked = false: allow request to proceed
 */

const CONFIG = require("../constants/config");
const { getPool } = require("../config/database");

/**
 * Creates session validation middleware
 * @returns {Function} Express middleware
 */
const createCheckActiveSessionMiddleware = () => {
  return async (req, res, next) => {
    try {
      // Must have req.user.uid from verifyTokenMiddleware
      const uid = req.user?.uid;

      if (!uid) {
        return res.status(401).json({
          success: false,
          error: "INVALID_USER",
        });
      }

      // Get pool and query most recent session
      const pool = getPool();
      const query = `
        SELECT revoked
        FROM active_sessions
        WHERE firebase_uid = $1
        ORDER BY last_active DESC
        LIMIT 1
      `;

      const result = await pool.query(query, [uid]);

      // No session found - deny access
      if (result.rows.length === 0) {
        return res.status(401).json({
          success: false,
          error: "SESSION_NOT_FOUND",
        });
      }

      const session = result.rows[0];

      // Session revoked - deny access (multi-device logout)
      if (session.revoked === true) {
        console.log(`[checkActiveSession] Session revoked for uid=${uid}`);
        return res.status(401).json({
          success: false,
          error: "SESSION_REVOKED",
        });
      }

      // Session valid - proceed
      next();
    } catch (error) {
      console.error("[checkActiveSession] Error:", error.message);
      res.status(500).json({
        success: false,
        error: CONFIG.ERRORS.INTERNAL_SERVER_ERROR,
      });
    }
  };
};

module.exports = { createCheckActiveSessionMiddleware };
