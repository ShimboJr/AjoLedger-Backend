/**
 * payments.js — payment settlement logic.
 *
 * settlePayment(reference) — full Paystack-verify + apply path.
 * applyVerifiedPayment(session, params) — exported for seed/testing without Paystack.
 */

import mongoose from 'mongoose';
import { Payment }     from '../models/Payment.js';
import { Obligation }  from '../models/Obligation.js';
import { Cycle }       from '../models/Cycle.js';
import { Circle }      from '../models/Circle.js';
import { User }        from '../models/User.js';
import * as paystackService from './paystackService.js';
import { appendLedgerEntry } from './ledger.js';
import { circleNow }   from '../utils/dates.js';

const MAX_RETRIES = 3;

// ── applyVerifiedPayment ──────────────────────────────────────────────────────

/**
 * applyVerifiedPayment — apply an already-verified (or seed) payment.
 *
 * Must be called INSIDE a Mongoose session transaction.
 * Handles: late gate, obligation status update, payment status update,
 * cycle potKobo increment, and ledger append.
 *
 * The seed script uses this directly with sandbox references, bypassing Paystack.
 *
 * @param {import('mongoose').ClientSession} session
 * @param {{
 *   payment: object,       lean Payment document
 *   obligation: object,    lean Obligation document (pre-loaded inside session)
 *   cycle: object,         lean Cycle document
 *   circle: object,        lean Circle document
 *   reference: string,
 *   gatewayMeta?: object,  optional gateway fields (channel, gateway_response)
 * }} params
 * @returns {{ obligation: object, settled: boolean, alreadySettled: boolean, reason?: string }}
 */
export async function applyVerifiedPayment(session, {
  payment,
  obligation,
  cycle,
  circle,
  reference,
  gatewayMeta = {},
}) {
  const now = circleNow(circle);

  // Late gate: reject payments after cycle hard deadline
  if (now > new Date(cycle.closesAt)) {
    await Payment.updateOne(
      { _id: payment._id },
      { $set: { status: 'failed' } },
      { session }
    );
    return {
      obligation: obligation,
      settled: false,
      alreadySettled: false,
      reason: 'cycle_closed',
    };
  }

  const obStatus = now <= new Date(cycle.dueDate) ? 'paid_on_time' : 'paid_late';

  // Conditional update — only applies when obligation is still pending
  const updatedOb = await Obligation.findOneAndUpdate(
    { _id: obligation._id, status: 'pending' },
    { $set: { status: obStatus, paidAt: now, reference } },
    { session, new: true }
  );

  if (!updatedOb) {
    // Already settled by a concurrent call
    await Payment.updateOne(
      { _id: payment._id },
      { $set: { status: 'success', settledAt: now } },
      { session }
    );
    return { obligation, settled: true, alreadySettled: true };
  }

  // Mark payment success
  await Payment.updateOne(
    { _id: payment._id },
    { $set: { status: 'success', settledAt: now } },
    { session }
  );

  // Update cycle's running pot total
  await Cycle.updateOne(
    { _id: cycle._id },
    { $inc: { potKobo: payment.amountKobo } },
    { session }
  );

  // Append contribution ledger entry
  await appendLedgerEntry(session, {
    circle:      payment.circle,
    cycle:       payment.cycle,
    cycleNumber: cycle.number,
    type:        'contribution',
    user:        payment.user,
    amountKobo:  payment.amountKobo,
    reference,
    meta: gatewayMeta,
  });

  return {
    obligation: updatedOb.toObject(),
    settled: true,
    alreadySettled: false,
  };
}

// ── settlePayment ─────────────────────────────────────────────────────────────

/**
 * settlePayment — verify a Paystack payment and record the outcome.
 *
 * @param {string} reference - our internal reference (AJT_...)
 * @returns {Promise<{
 *   payment: object,
 *   obligation: object | null,
 *   settled: boolean,
 *   alreadySettled: boolean,
 *   reason?: string
 * }>}
 */
export async function settlePayment(reference) {
  // 1. Load our Payment record
  const payment = await Payment.findOne({ reference }).lean();
  if (!payment) {
    throw Object.assign(new Error(`Payment not found for reference: ${reference}`), {
      code: 'PAYMENT_NOT_FOUND',
    });
  }

  // 2. Idempotent early return — already settled
  if (payment.status === 'success') {
    const obligation = await Obligation.findById(payment.obligation).lean();
    return { payment, obligation, settled: true, alreadySettled: true };
  }

  // 3. Verify with Paystack
  let psTxn;
  try {
    psTxn = await paystackService.verifyTransaction(reference);
  } catch (err) {
    throw err;
  }

  if (psTxn.status !== 'success') {
    await Payment.updateOne({ _id: payment._id }, { $set: { status: 'failed' } });
    return { payment: { ...payment, status: 'failed' }, obligation: null, settled: false, reason: `Paystack status: ${psTxn.status}` };
  }
  if (psTxn.currency !== 'NGN') {
    await Payment.updateOne({ _id: payment._id }, { $set: { status: 'failed' } });
    return { payment: { ...payment, status: 'failed' }, obligation: null, settled: false, reason: 'currency_mismatch' };
  }
  if (psTxn.amount !== payment.amountKobo) {
    await Payment.updateOne({ _id: payment._id }, { $set: { status: 'failed' } });
    return { payment: { ...payment, status: 'failed' }, obligation: null, settled: false, reason: `amount_mismatch: expected ${payment.amountKobo}, got ${psTxn.amount}` };
  }
  if (psTxn.reference !== reference) {
    await Payment.updateOne({ _id: payment._id }, { $set: { status: 'failed' } });
    return { payment: { ...payment, status: 'failed' }, obligation: null, settled: false, reason: 'reference_mismatch' };
  }

  // 4. Transactional settlement (retry on ledger seq conflict)
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        const obligation = await Obligation.findById(payment.obligation).session(session);
        const cycle      = await Cycle.findById(payment.cycle).session(session);
        const circle     = await Circle.findById(payment.circle).session(session);

        result = await applyVerifiedPayment(session, {
          payment,
          obligation,
          cycle: cycle.toObject(),
          circle: circle.toObject(),
          reference,
          gatewayMeta: {
            gateway_response: psTxn.gateway_response,
            channel:          psTxn.channel,
          },
        });
      });

      if (result) return { payment: { ...payment, status: 'success' }, ...result };
    } catch (err) {
      lastErr = err;
      if (err.code === 11000 && attempt < MAX_RETRIES - 1) continue;
      throw err;
    } finally {
      await session.endSession();
    }
  }
  throw lastErr;
}
