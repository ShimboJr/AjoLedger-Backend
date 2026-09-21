import rateLimit from 'express-rate-limit';

const isTest = process.env.NODE_ENV === 'test';

/**
 * Auth rate limiter: 10 requests per minute per IP.
 * Applied to /api/auth/register and /api/auth/login.
 * Skipped in test environment.
 */
export const authLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: isTest ? 0 : 10,  // 0 = unlimited in tests
  skip: () => isTest,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many requests. Please wait a moment and try again.',
    },
  },
});

/**
 * Public trust profile: 60 requests per minute per IP.
 * Skipped in test environment.
 */
export const publicTrustLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isTest ? 0 : 60,
  skip: () => isTest,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many requests. Please wait a moment and try again.',
    },
  },
});
