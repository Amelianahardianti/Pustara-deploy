/**
 * Survey Routes
 * Handles: save survey, get survey, update survey
 */

const express = require("express");
const CONFIG = require("../constants/config");
const UserSurveyService = require("../services/userSurveyService");

/**
 * Async error handler wrapper
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch((err) => {
    console.error(`Route error: ${err.message}`);
    res.status(500).json({ success: false, error: CONFIG.ERRORS.INTERNAL_SERVER_ERROR });
  });
};

/**
 * Create survey routes
 * @param {Function} verifyTokenMiddleware - Token verification middleware
 * @returns {Router} Express router
 */
function createSurveyRoutes(verifyTokenMiddleware) {
  const router = express.Router();

  // POST /survey/save - Save or update user survey
  // Flow: Verify Firebase token → Ensure user exists → Save survey
  router.post(
    "/save",
    verifyTokenMiddleware,
    asyncHandler(async (req, res) => {
      const UserService = require("../services/userService");
      
      const uid = req.user.uid;
      const email = req.user.email;
      const surveyData = req.body;

      // 1️⃣ Check if user exists in Azure SQL
      const userExists = await UserService.getUserByUid(uid);

      // 2️⃣ Auto-create user if needed (sync Firebase to SQL)
      if (!userExists.data) {
        console.log(`📝 New user detected (${email}), syncing to Azure SQL...`);
        const createResult = await UserService.createUser(uid, email);
        if (!createResult.success) {
          return res.status(500).json({
            success: false,
            error: "Failed to create user record",
          });
        }
        console.log(`✅ User synced successfully`);
      }

      // 3️⃣ Save survey data
      const result = await UserSurveyService.saveSurvey(uid, surveyData);
      res.status(result.success ? 201 : 400).json(result);
    })
  );

  // GET /survey/my-survey - Get user's survey
  router.get(
    "/my-survey",
    verifyTokenMiddleware,
    asyncHandler(async (req, res) => {
      const uid = req.user.uid;
      const result = await UserSurveyService.getSurveyByUid(uid);
      res.status(result.success ? 200 : 404).json(result);
    })
  );

  // GET /survey/status - Check if user has completed/skipped survey
  router.get(
    "/status",
    verifyTokenMiddleware,
    asyncHandler(async (req, res) => {
      const uid = req.user.uid;
      const result = await UserSurveyService.getSurveyStatus(uid);
      res.status(result.success ? 200 : 400).json(result);
    })
  );

  // POST /survey/skip - Persist survey skip to DB so user is not prompted again
  router.post(
    "/skip",
    verifyTokenMiddleware,
    asyncHandler(async (req, res) => {
      const uid = req.user.uid;
      const result = await UserSurveyService.skipSurvey(uid);
      res.status(result.success ? 200 : 400).json(result);
    })
  );

  // GET /survey/profile - Get user profile with survey data
  router.get(
    "/profile",
    verifyTokenMiddleware,
    asyncHandler(async (req, res) => {
      const uid = req.user.uid;
      const result = await UserSurveyService.getUserWithSurvey(uid);
      res.status(result.success ? 200 : 404).json(result);
    })
  );

  // PUT /survey/update - Update survey
  router.put(
    "/update",
    verifyTokenMiddleware,
    asyncHandler(async (req, res) => {
      const uid = req.user.uid;
      
      // Get user first to get userId
      const userService = require("../services/userService");
      const userResult = await userService.getUserByUid(uid);
      
      if (!userResult.success || !userResult.data) {
        return res.status(404).json({ success: false, error: "User not found" });
      }

      const result = await UserSurveyService.updateSurvey(userResult.data.id, req.body);
      res.status(result.success ? 200 : 400).json(result);
    })
  );

  return router;
}

module.exports = createSurveyRoutes;
