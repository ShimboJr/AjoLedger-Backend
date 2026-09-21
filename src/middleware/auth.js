import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { User } from '../models/User.js';

export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
    }

    const token = header.slice(7);
    let payload;
    try {
      payload = jwt.verify(token, env.JWT_SECRET);
    } catch {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' },
      });
    }

    const user = await User.findById(payload.sub).lean();
    if (!user) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'User not found' },
      });
    }

    // Attach user without passwordHash (select:false already excludes it, but be explicit)
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}
