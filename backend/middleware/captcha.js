/**
 * Cloudflare Turnstile CAPTCHA middleware
 *
 * Validates req.body.captchaToken for sensitive public auth routes.
 */

const CONFIG = require("../constants/config");
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

function getTurnstileSecret() {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (typeof secret === "string" && secret.trim()) {
    return secret.trim();
  }
  return null;
}

function getHeaderValue(header) {
  if (Array.isArray(header)) return header[0];
  return typeof header === "string" ? header : "";
}

function isLocalHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function shouldBypassCaptchaForLocalTesting(req) {
  const bypassEnabled = process.env.TURNSTILE_BYPASS_LOCAL === "true";
  const vercelEnv = process.env.VERCEL_ENV;

  // Never bypass on Vercel production.
  if (!bypassEnabled || vercelEnv === "production") {
    return false;
  }

  const origin = getHeaderValue(req.headers.origin);
  const referer = getHeaderValue(req.headers.referer);
  const candidate = origin || referer;
  if (!candidate) return false;

  try {
    const url = new URL(candidate);
    return isLocalHostname(url.hostname);
  } catch {
    return false;
  }
}

function mapTurnstileErrorMessage(errorCodes = []) {
  if (!Array.isArray(errorCodes) || errorCodes.length === 0) {
    return "CAPTCHA verification failed";
  }

  if (errorCodes.includes("missing-input-secret")) {
    return "CAPTCHA secret key is missing on server";
  }

  if (errorCodes.includes("invalid-input-secret")) {
    return "CAPTCHA secret key is invalid";
  }

  if (errorCodes.includes("bad-request")) {
    return "CAPTCHA verification request is malformed";
  }

  if (errorCodes.includes("internal-error")) {
    return "CAPTCHA provider internal error";
  }

  if (errorCodes.includes("timeout-or-duplicate")) {
    return "CAPTCHA token kedaluwarsa atau sudah digunakan. Silakan verifikasi ulang.";
  }

  if (errorCodes.includes("missing-input-response") || errorCodes.includes("invalid-input-response")) {
    return "Token CAPTCHA tidak valid. Silakan verifikasi ulang.";
  }

  return "CAPTCHA verification failed";
}

async function verifyTurnstileToken(token, remoteIp) {
  const secret = getTurnstileSecret();

  if (!secret) {
    // Fail closed for security-sensitive auth paths.
    console.error("[captcha] TURNSTILE_SECRET_KEY is missing or empty");
    return { success: false, error: "CAPTCHA secret key is not configured" };
  }

  if (!token || typeof token !== "string") {
    return { success: false, error: "CAPTCHA token is missing" };
  }

  try {
    const form = new URLSearchParams({
      secret,
      response: token,
    });

    if (remoteIp) {
      form.append("remoteip", remoteIp);
    }

    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const errorCodes = Array.isArray(payload?.["error-codes"]) ? payload["error-codes"] : [];
      return {
        success: false,
        error: errorCodes.length > 0 ? mapTurnstileErrorMessage(errorCodes) : "CAPTCHA service is unavailable",
        details: [`http-status-${response.status}`, ...errorCodes],
      };
    }

    const data = await response.json().catch(() => null);
    if (!data || typeof data !== "object") {
      return {
        success: false,
        error: "CAPTCHA service is unavailable",
        details: ["invalid-siteverify-response"],
      };
    }

    if (!data.success) {
      const errorCodes = data["error-codes"] || [];
      return {
        success: false,
        error: mapTurnstileErrorMessage(errorCodes),
        details: errorCodes,
      };
    }

    return { success: true };
  } catch (error) {
    console.error("CAPTCHA verification error:", error.message);
    return { success: false, error: "CAPTCHA verification failed" };
  }
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded && typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }

  return req.headers["cf-connecting-ip"] || req.headers["x-real-ip"] || req.socket.remoteAddress || undefined;
}

function createCaptchaMiddleware() {
  return async (req, res, next) => {
    if (shouldBypassCaptchaForLocalTesting(req)) {
      return next();
    }

    const token = req.body?.captchaToken;
    const remoteIp = getClientIp(req);
    const result = await verifyTurnstileToken(token, remoteIp);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error || CONFIG.ERRORS.CAPTCHA_FAILED,
        details: result.details || [],
      });
    }

    return next();
  };
}

module.exports = {
  createCaptchaMiddleware,
};
