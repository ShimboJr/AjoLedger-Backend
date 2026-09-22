/**
 * public.js — unauthenticated public routes.
 *
 * GET /api/public/trust/:slug
 *   Rate-limited: 60/min/IP (publicTrustLimiter).
 *   Returns identical 404 for unknown slug OR private profile (no info leak).
 *   Explicit allow-list projection — no email, no amounts.
 *   Cache-Control: public, max-age=60.
 */

import { Router }  from 'express';
import { User }    from '../models/User.js';
import { computeTrust, TIER_LABELS } from '../services/trust.js';
import { publicTrustLimiter } from '../middleware/rateLimit.js';

const router = Router();

// Identical 404 body used for both "not found" and "private" (no information leak)
const NOT_FOUND_BODY = {
  error: {
    code:    'NOT_FOUND',
    message: 'Trust profile not found',
  },
};

const DISCLAIMER =
  'Built from tamper-evident circle ledgers. ' +
  'Scores are computed from sandbox data. No real money moved.';

/**
 * Format a Date as "Month YYYY" — e.g. "September 2026".
 */
function memberSinceLabel(date) {
  if (!date) return null;
  return new Date(date).toLocaleDateString('en-NG', {
    month: 'long',
    year:  'numeric',
    timeZone: 'Africa/Lagos',
  });
}

/**
 * Format displayName as "First L." — e.g. "Ada O."
 */
function toDisplayName(fullName) {
  if (!fullName) return 'Anonymous';
  const parts = fullName.trim().split(/\s+/);
  const first = parts[0];
  const lastInitial = parts.length > 1 ? parts[parts.length - 1][0].toUpperCase() + '.' : '';
  return lastInitial ? `${first} ${lastInitial}` : first;
}

/**
 * GET /api/public/trust/:slug
 */
router.get('/trust/:slug', publicTrustLimiter, async (req, res, next) => {
  try {
    const { slug } = req.params;

    // Strict slug format guard — alphanumeric only
    if (!/^[a-z0-9-]{3,32}$/.test(slug)) {
      return res.status(404).json(NOT_FOUND_BODY);
    }

    const user = await User.findOne({ 'trust.slug': slug }).select('name trust createdAt').lean();

    // Unknown slug OR private profile — identical response
    if (!user || !user.trust?.isPublic) {
      return res.status(404).json(NOT_FOUND_BODY);
    }

    // Compute live score
    const trust = await computeTrust(user._id);

    // Explicit allow-list projection — ONLY these fields leave the server
    const payload = {
      displayName:     toDisplayName(user.name),
      score:           trust.score,
      tier:            trust.tier,
      tierLabel:       TIER_LABELS[trust.tier] ?? trust.tier,
      counts: {
        onTime: trust.onTime,
        late:   trust.late,
        missed: trust.missed,
      },
      resolvedCount:     trust.resolved,
      circlesCompleted:  trust.circlesCompleted,
      memberSince:       memberSinceLabel(user.createdAt),
      disclaimer:        DISCLAIMER,
    };

    res
      .set('Cache-Control', 'public, max-age=60')
      .json({ data: payload });
  } catch (err) {
    next(err);
  }
});

export default router;
