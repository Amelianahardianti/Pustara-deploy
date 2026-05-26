const UAParser = require("ua-parser-js");
const { getPool } = require("../config/database");

const MAX_ACTIVE_SESSIONS = 3;

async function revokeSessionsByIds(pool, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;

  const placeholders = ids.map((_, idx) => `$${idx + 1}`).join(', ');
  const revokeQuery = `
    UPDATE active_sessions
    SET revoked = TRUE
    WHERE id IN (${placeholders})
  `;

  await pool.query(revokeQuery, ids);
}

async function createSession(req, firebase_uid) {
  const pool = getPool();

  const clientProvidedDeviceId = req.body?.device_id;

  let device_name, browser, os;
  const normalizeClientValue = (value) => {
    const text = String(value || '').trim();
    if (!text) return null;
    const lowered = text.toLowerCase();
    if (lowered === 'unknown' || lowered === 'unknown browser' || lowered === 'unknown os') {
      return null;
    }
    return text;
  };

  const clientBrowser = normalizeClientValue(req.body?.browser);
  const clientOs = normalizeClientValue(req.body?.os);
  const clientDeviceName = normalizeClientValue(req.body?.device_name);

  const uaString = req.get("User-Agent") || req.headers["user-agent"] || "Unknown";
  const parser = new UAParser(uaString);
  const result = parser.getResult();

  const parsedBrowser = normalizeClientValue(result.browser.name);
  const parsedOs = normalizeClientValue(result.os.name);

  browser = parsedBrowser || clientBrowser || "Unknown";
  os = parsedOs || clientOs || "Unknown";
  device_name = clientDeviceName || `${browser} on ${os}`;

  const rawForwardedFor = req.headers["x-forwarded-for"];
  const forwardedIp = Array.isArray(rawForwardedFor)
    ? rawForwardedFor[0]
    : String(rawForwardedFor || '').split(',')[0].trim();
  const ip = forwardedIp || req.headers["x-real-ip"] || req.socket.remoteAddress;

  if (clientProvidedDeviceId) {
    const checkQuery = `
      SELECT id FROM active_sessions
      WHERE firebase_uid = $1
        AND device_id = $2
        AND revoked = FALSE
      ORDER BY last_active DESC;
    `;

    const checkResult = await pool.query(checkQuery, [firebase_uid, clientProvidedDeviceId]);

    if (checkResult.rows.length > 0) {
      const keepSessionId = checkResult.rows[0].id;
      const duplicateIds = checkResult.rows.slice(1).map((row) => row.id);
      await revokeSessionsByIds(pool, duplicateIds);

      console.log(`[createSession] 🎯 Matched device_id, updating session_id=${keepSessionId}`);

      const updateQuery = `
        UPDATE active_sessions
        SET last_active = NOW(),
            device_name = $2,
            browser = $3,
            os = $4,
            ip_address = $5,
            revoked = FALSE
        WHERE id = $1
        RETURNING *;
      `;

      const updateResult = await pool.query(updateQuery, [
        keepSessionId,
        device_name,
        browser,
        os,
        ip,
      ]);
      return updateResult.rows[0];
    }
  }

  if (browser && os) {
    const checkQuery = `
      SELECT id FROM active_sessions
      WHERE firebase_uid = $1
        AND browser = $2
        AND os = $3
        AND ip_address = $4
        AND revoked = FALSE
      ORDER BY last_active DESC;
    `;

    const checkResult = await pool.query(checkQuery, [firebase_uid, browser, os, ip]);

    if (checkResult.rows.length > 0) {
      const keepSessionId = checkResult.rows[0].id;
      const duplicateIds = checkResult.rows.slice(1).map((row) => row.id);
      await revokeSessionsByIds(pool, duplicateIds);

      console.log(`[createSession] ⏮️ Matched browser/os/ip, updating session_id=${keepSessionId}`);

      const updateQuery = `
        UPDATE active_sessions
        SET last_active = NOW(),
            device_name = $2,
            browser = $3,
            os = $4,
            ip_address = $5,
            revoked = FALSE
        WHERE id = $1
        RETURNING *;
      `;

      const updateResult = await pool.query(updateQuery, [
        keepSessionId,
        device_name,
        browser,
        os,
        ip,
      ]);
      return updateResult.rows[0];
    }
  }

  const activeSessionsResult = await pool.query(
    `
      SELECT id
      FROM active_sessions
      WHERE firebase_uid = $1
        AND revoked = FALSE
      ORDER BY last_active ASC
    `,
    [firebase_uid]
  );

  if (activeSessionsResult.rows.length >= MAX_ACTIVE_SESSIONS) {
    const revokeCount = activeSessionsResult.rows.length - MAX_ACTIVE_SESSIONS + 1;
    const idsToRevoke = activeSessionsResult.rows.slice(0, revokeCount).map((row) => row.id);
    await revokeSessionsByIds(pool, idsToRevoke);
    console.log(`[createSession] 🚫 Session limit reached. Revoked ${idsToRevoke.length} oldest session(s) for uid=${firebase_uid}`);
  }

  console.log(`[createSession] ✨ New session for firebase_uid=${firebase_uid}, device_id=${clientProvidedDeviceId || 'null'}`);

  const insertQuery = `
    INSERT INTO active_sessions
    (firebase_uid, device_id, device_name, browser, os, ip_address)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *;
  `;

  const values = [firebase_uid, clientProvidedDeviceId, device_name, browser, os, ip];
  const insertResult = await pool.query(insertQuery, values);

  return insertResult.rows[0];
}

module.exports = {
  createSession,
};