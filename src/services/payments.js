/**
 * payments.js — payment settlement logic.
 *
 * settlePayment(reference)
 *   Idempotent and safe to call multiple times. Used by:
 *   - GET  /api/payments/verify/:reference  (browser callback page)
 *   - POST /api/webhooks/paystack           (Paystack server-side event)
 *
 * Design:
 *   1. Load our Payment by reference (source of truth).
 *   2. If already settled → return early.
 *   3. Call Paystack verify; reject on status/currency/amount/reference mismatch.
 *   4. Wrap obligation update + payment update + ledger append in ONE transaction.
 *      Use a conditional filter on status:'pending' so a double call cannot
 *      double-apply (findOneAndUpdate returns null if already updated).
 *   5. Retry the whole transaction up to MAX_RETRIES times on a duplicate-seq
 *      (code 11000) from appendLedgerEntry.
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
  // ── 1. Load our Payment record ──────────────────────────────────────────────
  const payment = await Payment.findOne({ reference }).lean();
  if (!payment) {
    throw Object.assign(new Error(`Payment not found for reference: ${reference}`), {
      code: 'PAYMENT_NOT_FOUND',
    });
  }

  // ── 2. Idempotent early return — already settled ────────────────────────────
  if (payment.status === 'success') {
    const obligation = await Obligation.findById(payment.obligation).lean();
    return { payment, obligation, settled: true, alreadySettled: true };
  }

  // ── 3. Verify with Paystack ─────────────────────────────────────────────────
  let psTxn;
  try {
    psTxn = await paystackService.verifyTransaction(reference);
  } catch (err) {
    // Paystack unreachable or API error — do NOT mark as failed (could be transient)
    throw err;
  }

  // Validate Paystack response against our stored records
  if (psTxn.status !== 'success') {
    await Payment.updateOne({ _id: payment._id }, { $set: { status: 'failed' } });
    return { payment: { ...payment, status: 'failed' }, obligation: null, settled: false, reason: `Paystack status: ${psTxn.status}` };
  }
  if (psTxn.currency !== 'NGN') {
    await Payment.updateOne({ _id: payment._id }, { $set: { status: 'failed' } });
    return { payment: { ...payment, status: 'failed' }, obligation: null, settled: false, reason: 'currency_mismatch' };
  }
  if (psTxn.amount !== payment.amountKobo) {
    // Amount sent by Paystack doesn't match what we created — reject
    await Payment.updateOne({ _id: payment._id }, { $set: { status: 'failed' } });
    return {
      payment: { ...payment, status: 'failed' },
      obligation: null,
      settled: false,
      reason: `amount_mismatch: expected ${payment.amountKobo}, got ${psTxn.amount}`,
    };
  }
  if (psTxn.reference !== reference) {
    // Reference echo mismatch — should never happen; reject to be safe
    await Payment.updateOne({ _id: payment._id }, { $set: { status: 'failed' } });
    return { payment: { ...payment, status: 'failed' }, obligation: null, settled: false, reason: 'reference_mismatch' };
  }

  // ── 4. Transactional settlement (with retry on ledger seq conflict) ─────────
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        // Load supporting documents inside the transaction for consistency
        const obligation = await Obligation.findById(payment.obligation).session(session);
        const cycle      = await Cycle.findById(payment.cycle).session(session);
        const circle     = await Circle.findById(payment.circle).session(session);
        const user       = await User.findById(payment.user).lean();
        const now        = circleNow(circle);

        // Late gate: reject payments that arrive after the cycle hard deadline
        if (now > new Date(cycle.closesAt)) {
          await Payment.updateOne({ _id: payment._id }, { $set: { status: 'failed' } }, { session });
          result = { payment: { ...payment, status: 'failed' }, obligation: obligation.toObject(), settled: false, reason: 'cycle_closed' };
          return;
        }

        // Idempotency guard: conditional update — only apply if still pending
        const settled = now <= new Date(cycle.dueDate) ? 'paid_on_time' : 'paid_late';
        const updatedOb = await Obligation.findOneAndUpdate(
          { _id: obligation._id, status: 'pending' },
          { $set: { status: settled, paidAt: now, reference } },
          { session, new: true }
        );

        if (!updatedOb) {
          // Obligation was already updated (concurrent settle) — return current state
          const existingOb = obligation;
          await Payment.updateOne({ _id: payment._id }, { $set: { status: 'success', settledAt: now } }, { session });
          result = { payment: { ...payment, status: 'success' }, obligation: existingOb.toObject(), settled: true, alreadySettled: true };
          return;
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

        // Append ledger entry — may throw 11000 if concurrent settle races on seq
        await appendLedgerEntry(session, {
          circle:      payment.circle,
          cycle:       payment.cycle,
          cycleNumber: cycle.number,
          type:        'contribution',
          user:        payment.user,
          amountKobo:  payment.amountKobo,
          reference,
          meta: {
            gateway_response: psTxn.gateway_response,
            channel:          psTxn.channel,
          },
        });

        result = {
          payment:    { ...payment, status: 'success', settledAt: now },
          obligation: updatedOb.toObject(),
          settled:    true,
          alreadySettled: false,
        };
      });

      if (result) return result;
    } catch (err) {
      lastErr = err;
      // Retry on duplicate seq (11000) from appendLedgerEntry
      if (err.code === 11000 && attempt < MAX_RETRIES - 1) continue;
      throw err;
    } finally {
      await session.endSession();
    }
  }
  throw lastErr;
}
