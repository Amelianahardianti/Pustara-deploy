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
const UAParser = require("ua-parser-js");

function normalizeDeviceValue(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const lowered = text.toLowerCase();
  if (lowered === 'unknown' || lowered === 'unknown browser' || lowered === 'unknown os') {
    return null;
  }
  return text;
}

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

      // Resolve requester fingerprint so revocation can be checked per device, not globally.
      const rawForwardedFor = req.headers["x-forwarded-for"];
      const forwardedIp = Array.isArray(rawForwardedFor)
        ? rawForwardedFor[0]
        : String(rawForwardedFor || '').split(',')[0].trim();
      const ip = forwardedIp || req.headers["x-real-ip"] || req.socket.remoteAddress;

      const parser = new UAParser(
        req.get("User-Agent") || req.headers["user-agent"] || "Unknown"
      );
      const ua = parser.getResult();
      const browser = normalizeDeviceValue(ua.browser.name);
      const os = normalizeDeviceValue(ua.os.name);

      const headerDeviceId = String(req.headers["x-device-id"] || req.headers["x-deviceid"] || '').trim();

      // Get pool and query matching session for this requester device.
      const pool = getPool();
      let result;

      if (headerDeviceId) {
        result = await pool.query(
          `
            SELECT id, revoked
            FROM active_sessions
            WHERE firebase_uid = $1
              AND device_id = $2
            ORDER BY last_active DESC
            LIMIT 1
          `,
          [uid, headerDeviceId]
        );
      }

      if ((!result || result.rows.length === 0) && browser && os && ip) {
        result = await pool.query(
          `
            SELECT id, revoked
            FROM active_sessions
            WHERE firebase_uid = $1
              AND browser = $2
              AND os = $3
              AND ip_address = $4
            ORDER BY last_active DESC
            LIMIT 1
          `,
          [uid, browser, os, ip]
        );
      }

      if (!result || result.rows.length === 0) {
        result = await pool.query(
          `
            SELECT id, revoked
            FROM active_sessions
            WHERE firebase_uid = $1
            ORDER BY last_active DESC
            LIMIT 1
          `,
          [uid]
        );
      }

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
      if (session.id) {
        await pool.query(
          `
            UPDATE active_sessions
            SET last_active = NOW()
            WHERE id = $1
          `,
          [session.id]
        );
      }

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
