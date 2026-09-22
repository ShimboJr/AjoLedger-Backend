/**
 * me.js — routes under /api/me
 *
 * GET  /api/me/trust  → full trust profile { score, tier, label, counts,
 *                        slug, isPublic, publicUrl, ... }
 * PATCH /api/me/trust → update { isPublic?, regenerateSlug? }
 */

import { Router }      from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getTrustProfile, updateTrustSettings } from '../services/trust.js';

const router = Router();

/**
 * GET /api/me/trust
 */
router.get('/trust', requireAuth, async (req, res, next) => {
  try {
    const profile = await getTrustProfile(req.user._id);
    res.json({ data: profile });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/me/trust
 * Body: { isPublic?: boolean, regenerateSlug?: boolean }
 */
router.patch('/trust', requireAuth, async (req, res, next) => {
  try {
    const { isPublic, regenerateSlug } = req.body ?? {};

    // Coerce types — clients may send strings from forms
    const opts = {
      isPublic:       typeof isPublic === 'boolean' ? isPublic
                      : isPublic === 'true'  ? true
                      : isPublic === 'false' ? false
                      : undefined,
      regenerateSlug: Boolean(regenerateSlug),
    };

    const result = await updateTrustSettings(req.user._id, opts);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

export default router;
