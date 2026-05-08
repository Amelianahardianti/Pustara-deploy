/**
 * Recommendations Routes
 * Proxy to FastAPI AI server on Hugging Face.
 */

const express = require('express');
const { pushActivity, getUserRecentBooks } = require('../services/redis');
const UserSurveyService = require('../services/userSurveyService');

const getAiUrl = () => process.env.FASTAPI_URL || 'http://localhost:8001';

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeTrendingPages(book = {}) {
  return Math.max(
    0,
    toFiniteNumber(
      book.pages
        ?? book.page_count
        ?? book.num_pages
        ?? book.number_of_pages,
      0,
    ),
  );
}

function normalizeTrendingScore(book = {}) {
  const raw = toFiniteNumber(
    book.trending_score
      ?? book.trendingScore
      ?? book.score
      ?? book.trend_score,
    0,
  );

  // FastAPI may emit normalized 0..1 score; convert to readable scale for UI.
  if (raw > 0 && raw <= 1) return raw * 100;
  return Math.max(0, raw);
}

function normalizeSignal(signal, fallbackLabel, fallbackWeight, computedScore) {
  return {
    score: toFiniteNumber(computedScore, toFiniteNumber(signal?.score, 0)),
    weight: toFiniteNumber(signal?.weight, fallbackWeight),
    label: signal?.label || fallbackLabel,
  };
}

function signalScoreFromArray(arr, token) {
  if (!Array.isArray(arr)) return undefined;
  const found = arr.find((item) => {
    const label = String(item?.label || '').toLowerCase();
    return label.includes(token);
  });
  return found ? toFiniteNumber(found.value, undefined) : undefined;
}

function normalizeRecommendation(rec = {}) {
  const signalMap = rec?.signals_map || rec?.signals || {};
  const contentScoreRaw =
    signalMap?.content?.score ?? signalScoreFromArray(rec?.signals, 'konten') ?? signalScoreFromArray(rec?.signals, 'content');
  const collabScoreRaw =
    signalMap?.collab?.score ?? signalScoreFromArray(rec?.signals, 'collab') ?? signalScoreFromArray(rec?.signals, 'komunitas');

  const hasExplicitSignals = contentScoreRaw !== undefined || collabScoreRaw !== undefined;
  const hybridScore = Math.min(1, Math.max(0, toFiniteNumber(rec.hybrid_score ?? rec.final_score, 0)));
  const dominantToken = String(rec.dominant_signal || '').toLowerCase();
  const dominantHint = dominantToken.includes('collab') || dominantToken.includes('komunitas')
    ? 'collab'
    : dominantToken.includes('content') || dominantToken.includes('konten')
      ? 'content'
      : null;
  const fallbackDominant = dominantHint || 'content';

  const contentScore = Math.min(
    1,
    Math.max(0, toFiniteNumber(contentScoreRaw, hasExplicitSignals ? 0 : (fallbackDominant === 'content' ? hybridScore : 0))),
  );
  const collabScore = Math.min(
    1,
    Math.max(0, toFiniteNumber(collabScoreRaw, hasExplicitSignals ? 0 : (fallbackDominant === 'collab' ? hybridScore : 0))),
  );

  const dominant = dominantHint || (collabScore > contentScore ? 'collab' : 'content');

  return {
    book_id: String(rec.book_id || rec.id || ''),
    title: rec.title || 'Untitled',
    authors: rec.authors || rec.author || 'Unknown Author',
    cover_url: rec.cover_url || null,
    avg_rating: toFiniteNumber(rec.avg_rating, 0),
    reason_primary: rec.reason_primary || 'Rekomendasi dari PustarAI',
    reason_secondary: rec.reason_secondary ?? null,
    dominant_signal: dominant,
    hybrid_score: hybridScore,
    phase: rec.phase || '❄️ Cold',
    signals: {
      content: normalizeSignal(
        signalMap?.content,
        'Kemiripan konten',
        hasExplicitSignals ? 1 : (dominant === 'content' ? 1 : 0),
        contentScore,
      ),
      collab: normalizeSignal(
        signalMap?.collab,
        'Sinyal komunitas',
        hasExplicitSignals ? 0 : (dominant === 'collab' ? 1 : 0),
        collabScore,
      ),
    },
  };
}

function normalizeRecommendationsPayload(result = {}) {
  const recommendations = Array.isArray(result.recommendations)
    ? result.recommendations.map(normalizeRecommendation)
    : [];

  return {
    ...result,
    recommendations,
    show_recommendations:
      typeof result.show_recommendations === 'boolean'
        ? result.show_recommendations
        : recommendations.length > 0,
  };
}

function normalizeTrendingPayload(result = {}) {
  const source = Array.isArray(result.trending)
    ? result.trending
    : Array.isArray(result.recommendations)
      ? result.recommendations
      : [];

  const trending = source.map((book) => ({
    book_id: String(book.book_id || book.id || ''),
    title: book.title || 'Untitled',
    authors: book.authors || book.author || 'Unknown Author',
    genres: Array.isArray(book.genres)
      ? book.genres
      : typeof book.genres === 'string'
        ? book.genres.split(',').map((g) => g.trim()).filter(Boolean)
        : [],
    description: typeof book.description === 'string' ? book.description : '',
    year: book.year ? String(book.year) : '',
    pages: normalizeTrendingPages(book),
    avg_rating: toFiniteNumber(book.avg_rating, 0),
    cover_url: book.cover_url || null,
    trending_score: normalizeTrendingScore(book),
    reason_primary: book.reason_primary || 'Trending di Pustara',
  }));

  return {
    ...result,
    trending,
    recommendations: trending,
  };
}

const asyncHandler = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(err => {
    console.error('Recommendations route error:', err.message);
    res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  });

async function proxyToAI(method, path, body = null) {
  const url = `${getAiUrl()}${path}`;
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.HF_TOKEN}`,
    },
  };
  if (body) options.body = JSON.stringify(body);

  console.log(`[AI Proxy] ${method} → ${url}`);
  const response = await fetch(url, options);
  const data     = await response.json();

  if (!response.ok) {
    const err = new Error(data.detail || `AI service error: ${response.status}`);
    err.status = response.status;
    throw err;
  }
  return data;
}

/**
 * Fetch user survey data (gender, age, genre pref) from the DB.
 */
async function getUserSurveyContext(uid) {
  try {
    const result = await UserSurveyService.getSurveyByUid(uid);
    if (result.success && result.data) {
      if (result.data.survey_status === 'skipped') {
        return {
          user_gender: null,
          user_age: null,
          user_age_group: null,
          preferred_genres: null,
        };
      }

      let ageGroup = null;
      const exactAge = parseInt(result.data.age);
      if (!isNaN(exactAge)) {
        if (exactAge < 20) ageGroup = "<20";
        else if (exactAge <= 30) ageGroup = "21-30";
        else if (exactAge <= 40) ageGroup = "31-40";
        else ageGroup = ">40";
      } else {
        ageGroup = result.data.age; 
      }

      let genresArray = [];
      if (typeof result.data.favoriteGenre === 'string') {
        genresArray = result.data.favoriteGenre.split(',').map(g => g.trim());
      } else if (Array.isArray(result.data.favoriteGenre)) {
        genresArray = result.data.favoriteGenre;
      }

      genresArray = genresArray.filter((genre) => genre && genre !== '__SKIPPED__');

      return {
        user_gender:      result.data.gender || null, // "L", "P", "X"
        user_age:         result.data.age ? String(result.data.age) : null,
        user_age_group:   ageGroup,
        preferred_genres: genresArray.length > 0 ? genresArray : null,
      };
    }
  } catch (e) {
    console.warn('[Survey] Failed to fetch user survey:', e.message);
  }
  return {};
}

function createRecommendationsRoutes(verifyTokenMiddleware, optionalVerifyTokenMiddleware = (req, _res, next) => next()) {
  const router = express.Router();

  // ── POST /recommendations/chat ────────────────────────────────────────────
  router.post(
    '/chat',
    verifyTokenMiddleware,
    asyncHandler(async (req, res) => {
      const {
        query,
        top_n = 10,
        attached_book_title,
        attached_book_desc,
        context: clientContext = {},
      } = req.body;

      if (!query || query.trim() === '') {
        return res.status(400).json({ success: false, error: 'query is required' });
      }

      const uid = req.user.uid;

      const [surveyCtx, recentBooks] = await Promise.all([
        getUserSurveyContext(uid),
        getUserRecentBooks(uid, 10),
      ]);

      const result = await proxyToAI('POST', '/recommendations/chat', {
        message:             query,
        query,
        user_id:             uid,
        n:                   top_n,
        top_n,
        attached_book_title: attached_book_title || null,
        attached_book_desc:  attached_book_desc  || null,
        user_gender:         surveyCtx.user_gender,
        user_age:            surveyCtx.user_age,
        user_age_group:      surveyCtx.user_age_group,
        preferred_genres:    surveyCtx.preferred_genres, 
        chat_history:        req.body.chat_history || [],
        context: {
          ...clientContext,
          genre_pref:   surveyCtx.preferred_genres ? surveyCtx.preferred_genres.join(',') : null,
          recent_books: recentBooks,
        },
      });

      res.json({ success: true, data: normalizeRecommendationsPayload(result) });
    })
  );

  // ── POST /recommendations/direct ──────────────────────────────────────────
  router.post(
    '/direct',
    optionalVerifyTokenMiddleware,
    asyncHandler(async (req, res) => {
      const { book_id, seed_title, top_n = 10 } = req.body;
      const bid = book_id || seed_title;
      if (!bid) return res.status(400).json({ success: false, error: 'book_id is required' });

      const uid = req.user?.uid;
      if (uid) {
        pushActivity(uid, bid, 'view').catch(() => {});
      }

      const surveyCtx = uid ? await getUserSurveyContext(uid) : {};

      const payload = {
        book_id:          bid,
        seed_title:       bid,
        n:                top_n,
        top_n,
        user_gender:      surveyCtx.user_gender,
        user_age_group:   surveyCtx.user_age_group,
        preferred_genres: surveyCtx.preferred_genres
      };

      if (uid) {
        payload.user_id = uid;
      }

      const result = await proxyToAI('POST', '/recommendations/direct', payload);

      res.json({ success: true, data: normalizeRecommendationsPayload(result) });
    })
  );

  // ── POST /recommendations/activity ────────────────────────────────────────
  router.post(
    '/activity',
    verifyTokenMiddleware,
    asyncHandler(async (req, res) => {
      const { book_id, action } = req.body;
      const validActions = ['view', 'read', 'like', 'bookmark', 'wishlist', 'share', 'review'];

      if (!book_id || !validActions.includes(action)) {
        return res.status(400).json({
          success: false,
          error: `book_id and action (${validActions.join('/')}) are required`,
        });
      }

      const uid = req.user.uid;
      const normalizedAction = action === 'wishlist' ? 'bookmark' : action;

      const redisOk = await pushActivity(uid, book_id, action);

      proxyToAI('POST', '/activity', {
        user_id: uid,
        book_id: String(book_id),
        action: normalizedAction,
      }).catch(e => console.warn('[AI Proxy] /activity forward error:', e.message));

      res.json({ success: true, tracked: redisOk, action, book_id });
    })
  );

  // ── GET /recommendations/cold-start ───────────────────────────────────────
  router.get(
    '/cold-start',
    verifyTokenMiddleware,
    asyncHandler(async (req, res) => {
      const { top_n = 10, language, genres } = req.query;
      const surveyCtx = await getUserSurveyContext(req.user.uid);
      
      const params = new URLSearchParams({ n: top_n, top_n: top_n });
      if (language) params.set('language', language);
      params.set('user_id', req.user.uid);

      let requestGenres = null;
      if (typeof genres === 'string' && genres.trim()) {
        requestGenres = genres
          .split(',')
          .map((g) => g.trim())
          .filter(Boolean);
      }
      
      if (surveyCtx.user_gender) params.set('gender', surveyCtx.user_gender);
      if (surveyCtx.user_age_group) params.set('age_group', surveyCtx.user_age_group);
      const preferredGenres =
        surveyCtx.preferred_genres && surveyCtx.preferred_genres.length > 0
          ? surveyCtx.preferred_genres
          : requestGenres;
      if (preferredGenres && preferredGenres.length > 0) {
        params.set('genres', preferredGenres.join(','));
      }

      const result = await proxyToAI('GET', `/recommendations/cold-start?${params.toString()}`);
      res.json({ success: true, data: normalizeRecommendationsPayload(result) });
    })
  );

  // ── GET /recommendations/trending ─────────────────────────────────────────
  router.get(
    '/trending',
    optionalVerifyTokenMiddleware,
    asyncHandler(async (req, res) => {
      const { top_n = 10 } = req.query;
      const uid = req.user?.uid;
      const surveyCtx = uid ? await getUserSurveyContext(uid) : {};

      const params = new URLSearchParams({ n: top_n, top_n: top_n });
      
      if (surveyCtx.user_gender) params.set('gender', surveyCtx.user_gender);
      if (surveyCtx.user_age_group) params.set('age_group', surveyCtx.user_age_group);

      const result = await proxyToAI('GET', `/recommendations/trending?${params.toString()}`);
      res.json({ success: true, data: normalizeTrendingPayload(result) });
    })
  );

  // ── GET /recommendations/health ───────────────────────────────────────────
  router.get(
    '/health',
    asyncHandler(async (req, res) => {
      try {
        const result = await proxyToAI('GET', '/health');
        res.json({ success: true, ai_service: 'up', data: result });
      } catch (err) {
        res.status(503).json({ success: false, ai_service: 'down', error: err.message });
      }
    })
  );

  return router;
}

module.exports = createRecommendationsRoutes;