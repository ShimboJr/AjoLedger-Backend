/**
 * paymentController.js
 *
 * POST /api/circles/:id/contribute — initialize a Paystack checkout for a member's obligation
 * GET  /api/payments/verify/:reference — settle and return the payment result (browser callback)
 */

import { nanoid } from 'nanoid';
import { Circle }      from '../models/Circle.js';
import { Membership }  from '../models/Membership.js';
import { Cycle }       from '../models/Cycle.js';
import { Obligation }  from '../models/Obligation.js';
import { Payment }     from '../models/Payment.js';
import { User }        from '../models/User.js';
import { circleNow }   from '../utils/dates.js';
import { createError } from '../middleware/error.js';
import * as paystackService from '../services/paystackService.js';
import { settlePayment }    from '../services/payments.js';
import { env } from '../config/env.js';

// ── POST /api/circles/:id/contribute ─────────────────────────────────────────

export async function handleContribute(req, res, next) {
  try {
    const circleId = req.params.id;
    const userId   = req.user._id;

    // 1. Circle must exist and be active
    const circle = await Circle.findById(circleId).lean();
    if (!circle) throw createError(404, 'NOT_FOUND', 'Circle not found');
    if (circle.status !== 'active') {
      throw createError(400, 'BAD_REQUEST', 'Circle is not active');
    }

    // 2. Caller must be a member
    const membership = await Membership.findOne({ circle: circleId, user: userId }).lean();
    if (!membership) throw createError(404, 'NOT_FOUND', 'Circle not found');

    // 3. Must be an open cycle
    const cycle = await Cycle.findOne({ circle: circleId, status: 'open' }).lean();
    if (!cycle) throw createError(400, 'BAD_REQUEST', 'No open cycle');

    // 4. Caller must have a PENDING obligation for this cycle
    const obligation = await Obligation.findOne({ cycle: cycle._id, user: userId, status: 'pending' }).lean();
    if (!obligation) {
      const ob = await Obligation.findOne({ cycle: cycle._id, user: userId }).lean();
      if (ob) throw createError(400, 'BAD_REQUEST', `Your contribution for this cycle is already ${ob.status.replace('_', ' ')}`);
      throw createError(400, 'BAD_REQUEST', 'No pending obligation found for this cycle');
    }

    // 5. Must be before closesAt (cycle not expired)
    const now = circleNow(circle);
    if (now > new Date(cycle.closesAt)) {
      throw createError(400, 'BAD_REQUEST', 'The contribution window for this cycle has closed');
    }

    // 6. Amount comes from the obligation, NEVER from the request body
    const amountKobo = obligation.amountKobo;

    // 7. Check for an existing initialized payment for this obligation.
    //    If one exists it means the user previously opened Paystack checkout
    //    but didn't complete (cancelled, closed the tab, etc.).
    //    We MUST NOT reuse the same reference — Paystack rejects re-initialization
    //    of an already-seen reference with "Duplicate Transaction Reference" (HTTP 400).
    //    Instead: mark the stale payment as 'abandoned' and fall through to create
    //    a fresh reference below, which Paystack will accept.
    const existing = await Payment.findOne({ obligation: obligation._id, status: 'initialized' }).lean();
    if (existing) {
      await Payment.updateOne(
        { _id: existing._id },
        { $set: { status: 'abandoned' } }
      );
      // Fall through to steps 8–10 to create a new reference and Payment record.
    }

    // 8. Generate unique reference: AJT_<obligationId>_<8 random chars>
    const reference = `AJT_${String(obligation._id)}_${nanoid(8)}`;

    // 9. Create our Payment record BEFORE calling Paystack
    //    (so the reference exists in our DB even if Paystack is slow)
    const user = await User.findById(userId).lean();
    await Payment.create({
      reference,
      circle:      circleId,
      cycle:       cycle._id,
      obligation:  obligation._id,
      user:        userId,
      amountKobo,
      currency:    'NGN',
      status:      'initialized',
    });

    // 10. Call Paystack initialize
    let psResult;
    try {
      psResult = await paystackService.initializeTransaction({
        email:       user.email,
        amountKobo,
        reference,
        callbackUrl: `${env.CLIENT_URL}/payments/callback`,
        metadata: {
          obligationId: obligation._id,
          circleId,
          userId,
        },
      });
    } catch (err) {
      // Mark payment as failed so the user can retry
      await Payment.updateOne({ reference }, { $set: { status: 'failed' } });
      throw createError(502, 'PAYSTACK_ERROR', 'Could not reach Paystack. Please try again.');
    }

    return res.json({
      data: {
        authorizationUrl: psResult.authorizationUrl,
        reference,
      },
    });
  } catch (err) { next(err); }
}

// ── GET /api/payments/verify/:reference ─────────────────────────────────────

export async function handleVerifyPayment(req, res, next) {
  try {
    const { reference } = req.params;
    const userId = req.user._id;

    // Ownership check: only the payment's owner may verify
    const payment = await Payment.findOne({ reference }).lean();
    if (!payment) throw createError(404, 'NOT_FOUND', 'Payment not found');
    if (String(payment.user) !== String(userId)) {
      throw createError(403, 'FORBIDDEN', 'Access denied');
    }

    const result = await settlePayment(reference);

    return res.json({ data: result });
  } catch (err) { next(err); }
}
