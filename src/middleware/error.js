import { env } from '../config/env.js';

/**
 * Central error handler.
 * - Returns P0-compliant {error:{code,message,details?}} shape.
 * - Never leaks stack traces in production.
 * - Handles Mongoose validation errors, CastErrors, and duplicate-key errors.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const details = Object.values(err.errors).map((e) => ({
      field: e.path,
      message: e.message,
    }));
    return res.status(422).json({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid data', details },
    });
  }

  // Mongoose CastError (bad ObjectId etc.)
  if (err.name === 'CastError') {
    return res.status(400).json({
      error: { code: 'BAD_REQUEST', message: `Invalid value for field: ${err.path}` },
    });
  }

  // MongoDB duplicate-key error
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern ?? {})[0] ?? 'field';
    return res.status(409).json({
      error: { code: 'CONFLICT', message: `A record with that ${field} already exists` },
    });
  }

  // App-level known errors (thrown with statusCode + code)
  if (err.statusCode) {
    return res.status(err.statusCode).json({
      error: { code: err.code ?? 'ERROR', message: err.message },
    });
  }

  // Unknown / unexpected error
  const isProduction = env.NODE_ENV === 'production';
  console.error('[error]', err);

  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: isProduction ? 'An unexpected error occurred' : err.message,
      ...(isProduction ? {} : { stack: err.stack }),
    },
  });
}

/**
 * createError — factory for app-level errors with statusCode + code.
 */
export function createError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}
