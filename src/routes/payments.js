import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { handleVerifyPayment } from '../controllers/paymentController.js';

const router = Router();

// GET /api/payments/verify/:reference — browser callback page calls this
router.get('/verify/:reference', requireAuth, handleVerifyPayment);

export default router;
