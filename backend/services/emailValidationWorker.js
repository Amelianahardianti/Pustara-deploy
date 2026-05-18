const dns = require('dns').promises;

const CACHE_TTL_MS = Number(process.env.EMAIL_VALIDATION_CACHE_MS || 6 * 60 * 60 * 1000);
const WORKER_INTERVAL_MS = Number(process.env.EMAIL_VALIDATION_WORKER_INTERVAL_MS || 150);
const VALIDATION_TIMEOUT_MS = Number(process.env.EMAIL_VALIDATION_TIMEOUT_MS || 3500);
const MAX_CONCURRENCY = Number(process.env.EMAIL_VALIDATION_CONCURRENCY || 4);

const validationCache = new Map();
const waitingResolvers = new Map();
const queuedEmails = [];
const queuedSet = new Set();

let workerStarted = false;
let activeJobs = 0;

function isLikelyValidEmailFormat(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function parseRecipientList(recipientString) {
  return String(recipientString || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function getCache(email) {
  const cached = validationCache.get(email);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    validationCache.delete(email);
    return null;
  }
  return cached;
}

function setCache(email, result) {
  validationCache.set(email, {
    ...result,
    checkedAt: Date.now(),
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

function resolveAll(email, result) {
  const resolvers = waitingResolvers.get(email) || [];
  waitingResolvers.delete(email);
  resolvers.forEach((resolve) => resolve(result));
}

async function verifySingleEmail(email) {
  if (!isLikelyValidEmailFormat(email)) {
    return { email, valid: false, reason: 'invalid_format' };
  }

  const domain = email.split('@')[1];
  if (!domain || domain === 'localhost' || domain.endsWith('.local')) {
    return { email, valid: false, reason: 'invalid_domain' };
  }

  try {
    const mx = await dns.resolveMx(domain);
    if (Array.isArray(mx) && mx.length > 0) {
      return { email, valid: true, reason: 'mx_found' };
    }
  } catch (_) {
    // fallback below
  }

  try {
    const [a, aaaa] = await Promise.allSettled([dns.resolve4(domain), dns.resolve6(domain)]);
    const hasA = a.status === 'fulfilled' && Array.isArray(a.value) && a.value.length > 0;
    const hasAaaa = aaaa.status === 'fulfilled' && Array.isArray(aaaa.value) && aaaa.value.length > 0;
    if (hasA || hasAaaa) {
      return { email, valid: true, reason: 'domain_resolves_no_mx' };
    }
    return { email, valid: false, reason: 'domain_not_found' };
  } catch (_) {
    return { email, valid: false, reason: 'domain_not_found' };
  }
}

async function processOneEmail(email) {
  try {
    const result = await verifySingleEmail(email);
    setCache(email, result);
    resolveAll(email, result);
  } catch (_) {
    const fallback = { email, valid: false, reason: 'validation_error' };
    setCache(email, fallback);
    resolveAll(email, fallback);
  } finally {
    activeJobs -= 1;
    queuedSet.delete(email);
  }
}

function startValidationWorker() {
  if (workerStarted) return;
  workerStarted = true;

  setInterval(() => {
    while (activeJobs < MAX_CONCURRENCY && queuedEmails.length > 0) {
      const email = queuedEmails.shift();
      if (!email) continue;
      activeJobs += 1;
      processOneEmail(email);
    }
  }, WORKER_INTERVAL_MS);
}

function queueValidation(email) {
  const cached = getCache(email);
  if (cached) {
    return Promise.resolve(cached);
  }

  return new Promise((resolve) => {
    const resolvers = waitingResolvers.get(email) || [];
    resolvers.push(resolve);
    waitingResolvers.set(email, resolvers);

    if (!queuedSet.has(email)) {
      queuedSet.add(email);
      queuedEmails.push(email);
    }
  });
}

function withTimeout(promise, timeoutMs, fallback) {
  let timer = null;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }),
  ]);
}

async function validateRecipients(recipientString) {
  startValidationWorker();

  const emails = parseRecipientList(recipientString);
  if (emails.length === 0) {
    return { validRecipients: [], invalidRecipients: [] };
  }

  const strictMode = String(process.env.EMAIL_VALIDATION_STRICT || 'true').toLowerCase() !== 'false';

  const results = await Promise.all(
    emails.map((email) => withTimeout(
      queueValidation(email),
      VALIDATION_TIMEOUT_MS,
      { email, valid: !strictMode, reason: strictMode ? 'validation_timeout' : 'timeout_allowed' }
    ))
  );

  const validRecipients = [];
  const invalidRecipients = [];

  results.forEach((result) => {
    if (result.valid) validRecipients.push(result.email);
    else invalidRecipients.push({ email: result.email, reason: result.reason });
  });

  return { validRecipients, invalidRecipients };
}

module.exports = {
  validateRecipients,
  startValidationWorker,
};
