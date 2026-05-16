/**
 * Authentication Routes
 * Handles: signup, signin, verify-token, logout, profile
 */

const express = require("express");
const CONFIG = require("../constants/config");
const { createIPRateLimiter } = require("../middleware/rateLimit");
const { createCaptchaMiddleware } = require("../middleware/captcha");

/**
 * Async error handler wrapper
 * Catches errors and passes to error handler
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch((err) => {
    console.error(`Route error: ${err.message}`);
    res.status(500).json({ success: false, error: CONFIG.ERRORS.INTERNAL_SERVER_ERROR });
  });
};

/**
 * Create auth routes
 * @param {AuthService} authService - Service instance
 * @param {Function} verifyTokenMiddleware - Token verification middleware
 * @returns {Router} Express router
 */
function createAuthRoutes(authService, verifyTokenMiddleware) {
  const router = express.Router();
  const UserService = require("../services/userService");
  const { insertNotification } = require("../services/notificationService");
  const { sendEmail } = require("../services/emailService");
  const authRateLimiter = createIPRateLimiter(
    CONFIG.RATE_LIMIT.AUTH.window,
    CONFIG.RATE_LIMIT.AUTH.max
  );
  const captchaMiddleware = createCaptchaMiddleware();

  // POST /auth/signup - Register new user
  router.post(
    "/signup",
    authRateLimiter,
    captchaMiddleware,
    asyncHandler(async (req, res) => {
      const result = await authService.signUp(req.body.email, req.body.password);
      res.status(result.status).json(result);
    })
  );

  // POST /auth/signin - Login user
  router.post(
    "/signin",
    authRateLimiter,
    captchaMiddleware,
    asyncHandler(async (req, res) => {
      const result = await authService.signIn(req.body.email, req.body.password);
      res.status(result.status).json(result);
    })
  );

  // POST /auth/verify-token - Verify token & auto-create user in Azure SQL
  // Also returns the user's role from DB so frontend doesn't need a separate call
  router.post(
    "/verify-token",
    asyncHandler(async (req, res) => {
      const authResult = await authService.verifyToken(req.body.token);
      
      let role = 'reader';
      
      if (authResult.success) {
        const { uid, email, displayName } = authResult.user;
        
        // Auto-create user in Azure SQL jika belum ada
        const userExists = await UserService.getUserByUid(uid);
        if (!userExists.data) {
          console.log(`📝 First login detected for ${email}, syncing to Azure SQL...`);
          const created = await UserService.createUser(uid, email, displayName);
          try {
            const createdUserId = created?.data?.id;
            const name = displayName || email?.split('@')[0] || 'Pustara Reader';

            if (createdUserId) {
              await insertNotification({
                userId: String(createdUserId),
                type: 'system',
                title: 'Selamat Datang di Pustara',
                body: 'Akunmu sudah siap. Mulai jelajahi katalog, simpan wishlist, dan pinjam buku pertama kamu.',
              });
            }

            await sendEmail({
              to: email,
              subject: 'Pustara - Selamat Datang',
              text: [
                `Halo ${name},`,
                '',
                'Selamat datang di Pustara. Akunmu sudah aktif dan siap dipakai.',
                'Kamu bisa mulai eksplor katalog, membuat wishlist, dan meminjam buku digital.',
                '',
                'Selamat membaca!',
              ].join('\n'),
            }).catch((mailError) => {
              console.warn('Welcome email warning:', mailError.message);
            });
          } catch (welcomeError) {
            console.warn('Welcome notification warning:', welcomeError.message);
          }
          console.log(`✅ User synced successfully`);
        }
        
        // Get role from DB
        const roleResult = await UserService.getUserRole(uid);
        role = roleResult.success ? roleResult.role : 'reader';
        await UserService.recordLoginEvent(uid);
        console.log(`[verify-token] uid=${uid} email=${email} role=${role}`);
      }
      
      // Inject role into response
      const response = { ...authResult };
      if (response.data) {
        response.data.role = role;
      } else if (response.user) {
        response.data = { ...response.user, role };
      } else {
        response.data = { role };
      }
      
      res.status(authResult.status).json(response);
    })
  );

  // GET /auth/me - Get current user role (protected)
  router.get(
    "/me",
    verifyTokenMiddleware,
    asyncHandler(async (req, res) => {
      const uid = req.user.uid;
      const email = req.user.email;

      // Direct raw DB query for maximum reliability
      const { getPool } = require('../config/database');
      const pool = getPool();
      const result = await pool.query(
        'SELECT id, firebase_uid, email, role FROM users WHERE firebase_uid = $1',
        [uid]
      );

      console.log(`[/auth/me] token uid="${uid}" email="${email}"`);
      console.log(`[/auth/me] DB rows:`, JSON.stringify(result.rows));

      const row = result.rows[0];
      const role = row?.role || 'reader';

      res.status(200).json({
        success: true,
        data: { uid, email, role },
      });
    })
  );

  // POST /auth/logout - Logout (protected)
  router.post(
    "/logout",
    verifyTokenMiddleware,
    asyncHandler(async (req, res) => {
      const result = await authService.logout(req.user.uid);
      res.status(result.status).json(result);
    })
  );

  return router;
}

module.exports = { createAuthRoutes };
