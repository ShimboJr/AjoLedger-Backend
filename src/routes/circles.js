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
} from '../controllers/circleController.js';
import { handleContribute }              from '../controllers/paymentController.js';
import { handleListLedger, handleVerifyLedger } from '../controllers/ledgerController.js';

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

// NOTE: /ledger/verify MUST be declared before /ledger to avoid :id matching "verify"
router.get('/:id/ledger/verify', requireAuth, handleVerifyLedger);
router.get('/:id/ledger',        requireAuth, handleListLedger);

export default router;
