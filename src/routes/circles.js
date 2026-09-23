import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  createCircleSchema,
  payoutOrderSchema,
  handleCreateCircle,
  handleListCircles,
  handlePreviewCircle,
  handleJoinCircle,
  handleGetCircle,
  handleUpdatePayoutOrder,
  handleStartCircle,
  handleSimulate,
  handleRemoveMember,
} from '../controllers/circleController.js';
import { handleContribute }              from '../controllers/paymentController.js';
import { handleListLedger, handleVerifyLedger } from '../controllers/ledgerController.js';
import { buildLedgerCsv, circleNameToSlug }     from '../services/csv.js';
import { Membership } from '../models/Membership.js';
import { Circle }     from '../models/Circle.js';

const router = Router();

// ── Public (no auth) ──────────────────────────────────────────────────────────
// IMPORTANT: /join/:code MUST be before /:id so Express doesn't match "join" as an ID
router.get('/join/:code', handlePreviewCircle);

// ── Authenticated ──────────────────────────────────────────────────────────────
router.post('/', requireAuth, validate(createCircleSchema), handleCreateCircle);
router.get('/', requireAuth, handleListCircles);
router.post('/join/:code', requireAuth, handleJoinCircle);

router.get('/:id', requireAuth, handleGetCircle);
router.patch('/:id/payout-order', requireAuth, validate(payoutOrderSchema), handleUpdatePayoutOrder);
router.post('/:id/start',         requireAuth, handleStartCircle);
router.post('/:id/contribute',    requireAuth, handleContribute);
router.post('/:id/simulate',            requireAuth, handleSimulate);
router.delete('/:id/members/:userId',   requireAuth, handleRemoveMember);

// NOTE: /ledger/verify MUST be declared before /ledger to avoid :id matching "verify"
router.get('/:id/ledger/verify', requireAuth, handleVerifyLedger);
router.get('/:id/ledger',        requireAuth, handleListLedger);

// CSV download — members only
router.get('/:id/ledger.csv', requireAuth, async (req, res, next) => {
  try {
    const membership = await Membership.findOne({ circle: req.params.id, user: req.user._id }).lean();
    if (!membership) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Circle not found' } });

    const circle = await Circle.findById(req.params.id).lean();
    const csv    = await buildLedgerCsv(req.params.id);
    const slug   = circleNameToSlug(circle?.name ?? 'circle');
    const date   = new Date().toISOString().slice(0, 10);
    const filename = `ledger-${slug}-${date}.csv`;

    res
      .set('Content-Type', 'text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="${filename}"`)
      .send(csv);
  } catch (err) {
    next(err);
  }
});

export default router;
