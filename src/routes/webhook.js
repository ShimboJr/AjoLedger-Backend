import { Router } from 'express';
import { handlePaystackWebhook } from '../controllers/webhookController.js';

const router = Router();

// POST /api/webhooks/paystack
// IMPORTANT: this route must be mounted with express.raw({ type: 'application/json' })
// BEFORE express.json() in app.js so the raw Buffer is available for HMAC verification.
router.post('/paystack', handlePaystackWebhook);

export default router;
