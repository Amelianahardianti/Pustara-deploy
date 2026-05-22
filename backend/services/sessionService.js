const UAParser = require("ua-parser-js");
const { getPool } = require("../config/database");

async function createSession(req, firebase_uid) {
  const pool = getPool();

  // PRIMARY: Use persistent device_id from frontend (sent by AuthProvider)
  // This is the new reliable identifier for session matching
  const clientProvidedDeviceId = req.body?.device_id;

  let device_name, browser, os;
  const uaString =
  req.get("User-Agent") ||
  req.headers["user-agent"] ||
  "Unknown";

  const parser = new UAParser(uaString);
  const result = parser.getResult();

  browser = result.browser.name || "Unknown";
  os = result.os.name || "Unknown";

  device_name = `${browser} on ${os}`;




  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;

  // PRIMARY MATCHING: firebase_uid + device_id (most reliable, persistent)
  // New clients send device_id from localStorage - this is the preferred matching path
  if (clientProvidedDeviceId) {
    const checkQuery = `
      SELECT id FROM active_sessions
      WHERE firebase_uid = $1
        AND device_id = $2
        AND revoked = FALSE
      LIMIT 1;
    `;

    const checkResult = await pool.query(checkQuery, [
      firebase_uid,
      clientProvidedDeviceId,
    ]);

    // If session exists with same device_id, just update last_active
    if (checkResult.rows.length > 0) {
      console.log(
        `[createSession] 🎯 Matched device_id, updating session_id=${checkResult.rows[0].id}`
      );

      const updateQuery = `
        UPDATE active_sessions
        SET last_active = NOW()
        WHERE id = $1
        RETURNING *;
      `;

      const updateResult = await pool.query(updateQuery, [checkResult.rows[0].id]);
      return updateResult.rows[0];
    }
  }

  // SECONDARY MATCHING: firebase_uid + browser + os + ip (fallback for legacy clients)
  // This path handles old clients or cases where device_id is not available
  if (browser && os) {
    const checkQuery = `
      SELECT id FROM active_sessions
      WHERE firebase_uid = $1
        AND browser = $2
        AND os = $3
        AND ip_address = $4
        AND revoked = FALSE
      LIMIT 1;
    `;

    const checkResult = await pool.query(checkQuery, [
      firebase_uid,
      browser,
      os,
      ip,
    ]);

    // If session exists on same device (by browser/os/ip), just update last_active
    if (checkResult.rows.length > 0) {
      console.log(
        `[createSession] ⏮️ Matched browser/os/ip, updating session_id=${checkResult.rows[0].id}`
      );

      const updateQuery = `
        UPDATE active_sessions
        SET last_active = NOW()
        WHERE id = $1
        RETURNING *;
      `;

      const updateResult = await pool.query(updateQuery, [checkResult.rows[0].id]);
      return updateResult.rows[0];
    }
  }

  // NO MATCH FOUND: Create new session
  console.log(
    `[createSession] ✨ New session for firebase_uid=${firebase_uid}, device_id=${clientProvidedDeviceId || 'null'}`
  );

  const insertQuery = `
    INSERT INTO active_sessions
    (firebase_uid, device_id, device_name, browser, os, ip_address)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *;
  `;

  const values = [
    firebase_uid,
    clientProvidedDeviceId,
    device_name,
    browser,
    os,
    ip,
  ];

  const insertResult = await pool.query(insertQuery, values);

  return insertResult.rows[0];
}

module.exports = {
    createSession
};