import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { registerUser, loginUser, getMe } from '../services/authService.js';

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(60, 'Name must be at most 60 characters'),
  email: z.string().trim().toLowerCase().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(72, 'Password must be at most 72 characters'),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

/**
 * POST /api/auth/register
 */
export async function register(req, res, next) {
  try {
    const { token, user } = await registerUser(req.body);
    return res.status(201).json({ data: { token, user } });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/auth/login
 */
export async function login(req, res, next) {
  try {
    const { token, user } = await loginUser(req.body);
    return res.json({ data: { token, user } });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/auth/me
 */
export async function me(req, res, next) {
  try {
    const user = await getMe(req.user._id);
    return res.json({ data: { user } });
  } catch (err) {
    next(err);
  }
}

export { validate, requireAuth, authLimiter, registerSchema, loginSchema };
