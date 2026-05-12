/**
 * User Survey Service - Database Operations
 * Handles CRUD operations untuk user survey data di Azure SQL & Neon (Dummy)
 */

const { executeQuery, isNeon } = require('../config/database');
const UserService = require('./userService');

const SKIPPED_SENTINEL = '__SKIPPED__';

function toNull(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function normalizeFavoriteGenre(value) {
  if (Array.isArray(value)) {
    const list = value.map((item) => String(item).trim()).filter(Boolean);
    return list.length > 0 ? list.join(', ') : null;
  }

  const text = toNull(value);
  if (!text) return null;
  if (text === SKIPPED_SENTINEL) return text;
  return text;
}

function normalizeSurveyRecord(row) {
  if (!row) return null;

  const favoriteGenreRaw = row.favoritegenre ?? row.favoriteGenre ?? null;
  const ageRaw = row.age ?? null;
  const genderRaw = row.gender ?? null;
  const favoriteGenre = toNull(favoriteGenreRaw);
  const age = toNull(ageRaw);
  const gender = toNull(genderRaw);

  const skipped = favoriteGenre === SKIPPED_SENTINEL;
  const hasSurveyData = !skipped && Boolean(favoriteGenre || age || gender);
  const status = skipped ? 'skipped' : hasSurveyData ? 'completed' : 'not_started';

  return {
    ...row,
    favoriteGenre,
    age,
    gender,
    survey_status: status,
    has_survey: skipped || hasSurveyData,
    skipped,
  };
}

function parseFavoriteGenreList(value) {
  const text = toNull(value);
  if (!text || text === SKIPPED_SENTINEL) return [];
  return text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function syncUserPreferredGenres(userId, favoriteGenre) {
  const preferredGenres = parseFavoriteGenreList(favoriteGenre);
  const userTable = isNeon ? 'users' : 'Users';
  // If no genres selected, store NULL to clear the field
  const hasAny = Array.isArray(preferredGenres) && preferredGenres.length > 0;

  // For Neon/Postgres, pass a real JS array so node-postgres will bind it to a Postgres array type (text[]).
  // For Azure SQL, keep JSON string because Azure schema stores JSON in an NVARCHAR field.
  const valueToSet = hasAny ? (isNeon ? preferredGenres : JSON.stringify(preferredGenres)) : null;

  await executeQuery(
    `UPDATE ${userTable} SET preferred_genres = $2 WHERE id = $1`,
    [userId, valueToSet]
  );
}

async function upsertSurvey(userId, gender, age, favoriteGenre) {
  let query = '';

  if (isNeon) {
    query = `
      INSERT INTO UserSurvey (userId, gender, age, favoriteGenre)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (userId) DO UPDATE
      SET gender = EXCLUDED.gender,
          age = EXCLUDED.age,
          favoriteGenre = EXCLUDED.favoriteGenre,
          updatedAt = NOW()
      RETURNING *
    `;
  } else {
    query = `
      MERGE UserSurvey AS target
      USING (SELECT $1 AS userId, $2 AS gender, $3 AS age, $4 AS favoriteGenre) AS source
      ON (target.userId = source.userId)
      WHEN MATCHED THEN
          UPDATE SET gender = source.gender, age = source.age, favoriteGenre = source.favoriteGenre, updatedAt = GETDATE()
      WHEN NOT MATCHED THEN
          INSERT (userId, gender, age, favoriteGenre) VALUES (source.userId, source.gender, source.age, source.favoriteGenre);
      SELECT * FROM UserSurvey WHERE userId = $1;
    `;
  }

  const rows = await executeQuery(query, [userId, gender, age, favoriteGenre]);
  return rows[0] || null;
}

class UserSurveyService {
  /**
   * Save survey response untuk user
   */
  static async saveSurvey(uid, surveyData) {
    try {
      const userResult = await UserService.getUserByUid(uid);
      if (!userResult.success || !userResult.data) {
        return { success: false, error: 'User not found in database. Please ensure you are logged in.' };
      }
      const userId = userResult.data.id;

      const { gender, age, favoriteGenre } = surveyData;
      const saved = await upsertSurvey(
        userId,
        toNull(gender),
        toNull(age),
        normalizeFavoriteGenre(favoriteGenre)
      );

      await syncUserPreferredGenres(userId, saved?.favoriteGenre ?? favoriteGenre ?? null);

      const normalized = normalizeSurveyRecord(saved);

      return {
        success: true,
        message: 'Survey saved successfully',
        data: normalized,
      };
    } catch (error) {
      console.error('Error saving survey:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get user survey by UID
   */
  static async getSurveyByUid(uid) {
    try {
      const userResult = await UserService.getUserByUid(uid);
      if (!userResult.success || !userResult.data) {
        return { success: false, error: 'User not found' };
      }

      const rows = await executeQuery('SELECT * FROM UserSurvey WHERE userId = $1', [userResult.data.id]);
      return { success: true, data: normalizeSurveyRecord(rows[0] || null) };
    } catch (error) {
      console.error('Error getting survey:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Update survey
   */
  static async updateSurvey(userId, updates) {
    try {
      const allowedFields = ['favoriteGenre', 'age', 'gender'];
      const fields = Object.keys(updates).filter(k => allowedFields.includes(k));
      
      if (fields.length === 0) {
        return { success: false, error: 'No valid fields to update' };
      }

      const existingRows = await executeQuery('SELECT * FROM UserSurvey WHERE userId = $1', [userId]);
      const existing = existingRows[0] || null;

      const saved = await upsertSurvey(
        userId,
        fields.includes('gender') ? toNull(updates.gender) : toNull(existing?.gender),
        fields.includes('age') ? toNull(updates.age) : toNull(existing?.age),
        fields.includes('favoriteGenre')
          ? normalizeFavoriteGenre(updates.favoriteGenre)
          : normalizeFavoriteGenre(existing?.favoriteGenre)
      );

      await syncUserPreferredGenres(userId, saved?.favoriteGenre ?? null);
      return { success: true, data: normalizeSurveyRecord(saved) };
    } catch (error) {
      console.error('Error updating survey:', error);
      return { success: false, error: error.message };
    }
  }

  static async skipSurvey(uid) {
    try {
      const userResult = await UserService.getUserByUid(uid);
      if (!userResult.success || !userResult.data) {
        return { success: false, error: 'User not found in database. Please ensure you are logged in.' };
      }

      const saved = await upsertSurvey(userResult.data.id, null, null, SKIPPED_SENTINEL);
      await syncUserPreferredGenres(userResult.data.id, null);
      const normalized = normalizeSurveyRecord(saved);

      return {
        success: true,
        message: 'Survey skipped successfully',
        data: normalized,
      };
    } catch (error) {
      console.error('Error skipping survey:', error);
      return { success: false, error: error.message };
    }
  }

  static async getSurveyStatus(uid) {
    try {
      const surveyResult = await this.getSurveyByUid(uid);
      if (!surveyResult.success) {
        return {
          success: true,
          data: {
            has_survey: false,
            survey_status: 'not_started',
            should_prompt_personalization: false,
          },
        };
      }

      const data = surveyResult.data;
      if (!data) {
        const userResult = await UserService.getUserByUid(uid);
        const createdAtRaw = userResult?.data?.created_at ?? userResult?.data?.createdAt ?? null;
        const createdAt = createdAtRaw ? new Date(createdAtRaw) : null;
        const isFreshSignup =
          createdAt instanceof Date &&
          !Number.isNaN(createdAt.getTime()) &&
          Date.now() - createdAt.getTime() <= 60 * 60 * 1000;

        return {
          success: true,
          data: {
            has_survey: false,
            survey_status: 'not_started',
            should_prompt_personalization: Boolean(isFreshSignup),
          },
        };
      }

      return {
        success: true,
        data: {
          has_survey: Boolean(data.has_survey),
          survey_status: data.survey_status,
          skipped: Boolean(data.skipped),
          should_prompt_personalization: data.survey_status === 'not_started',
        },
      };
    } catch (error) {
      console.error('Error getting survey status:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get user with survey data
   */
  static async getUserWithSurvey(uid) {
    try {
      const userCol = isNeon ? 'firebase_uid' : 'uid';
      const userTable = isNeon ? 'users' : 'Users';
      
      // Ambil detail survey yang relevan sesuai skema
      const query = `
        SELECT u.*, us.favoriteGenre, us.age, us.gender
        FROM ${userTable} u
        LEFT JOIN UserSurvey us ON u.id = us.userId
        WHERE u.${userCol} = $1
      `;

      const rows = await executeQuery(query, [uid]);
      const row = rows[0] || null;
      const survey = normalizeSurveyRecord(row);
      return {
        success: true,
        data: row
          ? {
              ...row,
              survey_status: survey?.survey_status || 'not_started',
              has_survey: survey?.has_survey || false,
            }
          : null,
      };
    } catch (error) {
      console.error('Error getting user with survey:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = UserSurveyService;