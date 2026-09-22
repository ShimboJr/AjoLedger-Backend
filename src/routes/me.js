/**
 * me.js — routes under /api/me
 * GET /api/me/trust → returns the caller's reliability trust data.
 */

import { Router }      from 'express';
import { requireAuth } from '../middleware/auth.js';
import { computeTrust } from '../services/trust.js';

const router = Router();

/**
 * GET /api/me/trust
 * Returns { score, tier, label, onTime, late, missed, resolved,
 *           circlesJoined, circlesCompleted, memberSince }
 */
router.get('/trust', requireAuth, async (req, res, next) => {
  try {
    const trust = await computeTrust(req.user._id);
    res.json({ data: trust });
  } catch (err) {
    next(err);
  }
});

export default router;
