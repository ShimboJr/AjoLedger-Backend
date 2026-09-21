import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { User } from '../models/User.js';
import { env } from '../config/env.js';
import { generateTrustSlug } from '../utils/ids.js';
import { createError } from '../middleware/error.js';

const BCRYPT_COST = 10;

/**
 * Strips sensitive fields from a Mongoose user document or lean object.
 * Never returns passwordHash.
 */
export function sanitizeUser(user) {
  const obj = user.toObject ? user.toObject() : { ...user };
  delete obj.passwordHash;
  return obj;
}

/**
 * signToken(userId) — signs a JWT for the given user ID.
 */
export function signToken(userId) {
  return jwt.sign({ sub: String(userId) }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  });
}

/**
 * registerUser({ name, email, password }) — creates a new user.
 * Throws 409 on duplicate email.
 */
export async function registerUser({ name, email, password }) {
  const existing = await User.findOne({ email }).lean();
  if (existing) {
    throw createError(409, 'CONFLICT', 'An account with this email already exists');
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const slug = generateTrustSlug();

  const user = await User.create({
    name,
    email,
    passwordHash,
    trust: { slug, isPublic: false },
  });

  const token = signToken(user._id);
  return { token, user: sanitizeUser(user) };
}

/**
 * loginUser({ email, password }) — authenticates a user.
 * Always throws a generic error on any failure (timing-safe-ish).
 */
export async function loginUser({ email, password }) {
  // We need passwordHash, so explicitly select it
  const user = await User.findOne({ email }).select('+passwordHash').lean();

  // Always run bcrypt compare to prevent timing attacks on unknown emails.
  // DUMMY_HASH is bcrypt.hashSync('__dummy__', 10) — pre-computed to avoid startup cost.
  // bcrypt.compare with a valid hash always takes the same time, regardless of match.
  const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
  let isMatch = false;
  if (user) {
    isMatch = await bcrypt.compare(password, user.passwordHash);
  } else {
    // Run compare to waste timing; result is always discarded
    await bcrypt.compare(password, DUMMY_HASH);
  }


  if (!user || !isMatch) {
    throw createError(401, 'UNAUTHORIZED', 'Invalid email or password');
  }

  const token = signToken(user._id);
  return { token, user: sanitizeUser(user) };
}

/**
 * getMe(userId) — returns the authenticated user object (no passwordHash).
 */
export async function getMe(userId) {
  const user = await User.findById(userId).lean();
  if (!user) throw createError(404, 'NOT_FOUND', 'User not found');
  return sanitizeUser(user);
}
