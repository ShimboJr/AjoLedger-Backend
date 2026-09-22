/**
 * engine.js — cycle engine.
 *
 * runEngine({ circleId? })
 *   Processes all active circles (or one). For each circle, loops while the
 *   open cycle's closesAt <= circleNow, calling closeCycle up to 24 times.
 *
 * closeCycle(circle, cycle)
 *   Idempotent and transactional:
 *   - Marks every still-pending obligation as 'missed' and appends a 'missed'
 *     ledger entry for each (amountKobo = obligation amount; meta says not real money).
 *   - potKobo = sum of contributions actually paid. Appends a sandbox 'payout'
 *     ledger entry to the recipient; if any missed, adds shortfallKobo to meta.
 *     Skips payout entry if pot is 0.
 *   - Sets cycle to 'closed' (closedAt, potKobo). If last cycle marks circle
 *     'completed'; otherwise opens the next cycle and creates obligations.
 *   - Creates in-app Notifications (deduped with dedupeKey).
 *   Returns a summary object describing what happened.
 */

import mongoose from 'mongoose';
import { Circle }       from '../models/Circle.js';
import { Cycle }        from '../models/Cycle.js';
import { Obligation }   from '../models/Obligation.js';
import { Membership }   from '../models/Membership.js';
import { Notification } from '../models/Notification.js';
import { appendLedgerEntry } from './ledger.js';
import { circleNow }    from '../utils/dates.js';

const MAX_RETRIES = 3;

// ── Notification helper (deduped, never throws) ──────────────────────────────

async function tryCreateNotification(data) {
  try {
    return await Notification.create(data);
  } catch (err) {
    if (err.code === 11000) return null; // Deduplication — expected and correct
    console.error('[engine] Notification create error:', err.message);
    return null;
  }
}

// ── closeCycle ────────────────────────────────────────────────────────────────

/**
 * closeCycle(circle, cycle) — close one cycle.
 *
 * @param {object} circle - lean Circle document
 * @param {object} cycle  - lean Cycle document
 * @returns {{ skipped: true } | CloseResult}
 *
 * @typedef {{ cycleNumber: number, missedUserIds: ObjectId[], potKobo: number,
 *             shortfallKobo: number, isLastCycle: boolean,
 *             nextCycleNumber: number|null }} CloseResult
 */
export async function closeCycle(circle, cycle) {
  // Idempotent guard — pre-transaction fast exit
  if (cycle.status === 'closed') return { skipped: true };

  let closeResult;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        // Re-check inside transaction (guards against concurrent close calls)
        const freshCycle = await Cycle.findById(cycle._id).session(session).lean();
        if (!freshCycle || freshCycle.status === 'closed') {
          closeResult = { skipped: true };
          return;
        }

        // ── 1. Load all obligations ───────────────────────────────────────────
        const obligations = await Obligation.find({ cycle: cycle._id })
          .session(session)
          .lean();

        // ── 2. Mark pending obligations as missed ─────────────────────────────
        const missedObs = obligations.filter((o) => o.status === 'pending');
        if (missedObs.length > 0) {
          await Obligation.updateMany(
            { _id: { $in: missedObs.map((o) => o._id) }, status: 'pending' },
            { $set: { status: 'missed' } },
            { session }
          );
        }

        // ── 3. Append 'missed' ledger entries (one per missed member) ─────────
        for (const ob of missedObs) {
          await appendLedgerEntry(session, {
            circle:      circle._id,
            cycle:       cycle._id,
            cycleNumber: cycle.number,
            type:        'missed',
            user:        ob.user,
            amountKobo:  ob.amountKobo,
            meta: { note: 'Obligation not fulfilled — no real money moved' },
          });
        }

        // ── 4. Compute pot from paid obligations ──────────────────────────────
        const paidObs = obligations.filter(
          (o) => o.status === 'paid_on_time' || o.status === 'paid_late'
        );
        const potKobo = paidObs.reduce((sum, o) => sum + o.amountKobo, 0);
        const expectedPotKobo = obligations.length * circle.contributionKobo;
        const shortfallKobo = Math.max(0, expectedPotKobo - potKobo);

        // ── 5. Append 'payout' ledger entry (skip if pot is 0) ───────────────
        if (potKobo > 0) {
          await appendLedgerEntry(session, {
            circle:      circle._id,
            cycle:       cycle._id,
            cycleNumber: cycle.number,
            type:        'payout',
            user:        cycle.recipient,
            amountKobo:  potKobo,
            meta: {
              note: 'Sandbox payout — no real money moved',
              ...(shortfallKobo > 0 ? { shortfallKobo } : {}),
            },
          });
        }

        // ── 6. Close the cycle ────────────────────────────────────────────────
        const closedAt = circleNow(circle);
        await Cycle.updateOne(
          { _id: cycle._id },
          { $set: { status: 'closed', closedAt, potKobo } },
          { session }
        );

        // ── 7. Determine if last cycle or open next ───────────────────────────
        const isLastCycle = cycle.number >= circle.totalCycles;

        if (isLastCycle) {
          await Circle.updateOne(
            { _id: circle._id },
            { $set: { status: 'completed' } },
            { session }
          );
        } else {
          const nextCycle = await Cycle.findOne({
            circle: circle._id,
            number: cycle.number + 1,
          })
            .session(session)
            .lean();

          if (!nextCycle) {
            throw new Error(
              `[engine] Cycle ${cycle.number + 1} not found for circle ${circle._id}`
            );
          }

          await Cycle.updateOne(
            { _id: nextCycle._id },
            { $set: { status: 'open' } },
            { session }
          );

          await Circle.updateOne(
            { _id: circle._id },
            { $set: { currentCycleNumber: nextCycle.number } },
            { session }
          );

          // Create pending obligations for next cycle
          const memberships = await Membership.find({ circle: circle._id })
            .sort({ position: 1 })
            .session(session)
            .lean();

          const obligationDocs = memberships.map((m) => ({
            circle:      circle._id,
            cycle:       nextCycle._id,
            cycleNumber: nextCycle.number,
            user:        m.user,
            amountKobo:  circle.contributionKobo,
            status:      'pending',
          }));

          await Obligation.insertMany(obligationDocs, { session });
        }

        closeResult = {
          cycleNumber:     cycle.number,
          missedUserIds:   missedObs.map((o) => o.user),
          potKobo,
          shortfallKobo,
          isLastCycle,
          nextCycleNumber: isLastCycle ? null : cycle.number + 1,
        };
      });

      break; // Transaction succeeded
    } catch (err) {
      // Retry on duplicate ledger seq (race condition — very rare)
      if (err.code === 11000 && attempt < MAX_RETRIES - 1) continue;
      throw err;
    } finally {
      await session.endSession();
    }
  }

  if (!closeResult || closeResult.skipped) return { skipped: true };

  // ── Post-transaction: create in-app notifications (deduped) ─────────────────
  const { cycleNumber, missedUserIds, potKobo, isLastCycle, nextCycleNumber } = closeResult;

  // 'payment_missed' for each missed member
  for (const userId of missedUserIds) {
    await tryCreateNotification({
      user:      userId,
      circle:    circle._id,
      kind:      'payment_missed',
      title:     'You missed a contribution',
      body:      `Your contribution for cycle ${cycleNumber} of "${circle.name}" was not received before the deadline.`,
      dedupeKey: `eng:missed:${cycle._id}:${userId}`,
    });
  }

  // 'payout_sent' for recipient
  if (potKobo > 0) {
    await tryCreateNotification({
      user:      cycle.recipient,
      circle:    circle._id,
      kind:      'payout_sent',
      title:     'Payout received! (Sandbox)',
      body:      `You received ₦${(potKobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })} from cycle ${cycleNumber} of "${circle.name}". Sandbox only — no real money moved.`,
      dedupeKey: `eng:payout:${cycle._id}`,
    });
  }

  // Fetch all members for circle/completed notifications
  const memberships = await Membership.find({ circle: circle._id }).lean();

  if (isLastCycle) {
    // 'circle_completed' for all members (single dedupeKey — everyone gets same msg)
    for (const m of memberships) {
      await tryCreateNotification({
        user:      m.user,
        circle:    circle._id,
        kind:      'circle_completed',
        title:     'Circle completed! 🎉',
        body:      `"${circle.name}" has finished all ${circle.totalCycles} cycles. Well done to everyone!`,
        dedupeKey: `eng:completed:${circle._id}:${m.user}`,
      });
    }
  } else {
    // 'cycle_open' for all members
    for (const m of memberships) {
      await tryCreateNotification({
        user:      m.user,
        circle:    circle._id,
        kind:      'cycle_open',
        title:     `Cycle ${nextCycleNumber} is open`,
        body:      `Cycle ${nextCycleNumber} of "${circle.name}" is now open. Contributions are due.`,
        dedupeKey: `eng:cycle_open:${cycle._id}:${m.user}`,
      });
    }
  }

  return closeResult;
}

// ── runEngine ─────────────────────────────────────────────────────────────────

/**
 * runEngine({ circleId? }) — process all (or one) active circles.
 *
 * @param {{ circleId?: string|ObjectId }} [options]
 * @returns {Promise<Array<{ circleId, circleName, cyclesClosed, missedCount }>>}
 */
export async function runEngine({ circleId } = {}) {
  const query = circleId
    ? { _id: circleId, status: 'active' }
    : { status: 'active' };

  const circles = await Circle.find(query).lean();
  const summary = [];

  for (let circle of circles) {
    let cyclesClosed = 0;
    const allMissedIds = [];

    for (let i = 0; i < 24; i++) {
      // Reload circle each iteration — simulatedNow / status may have changed
      const freshCircle = await Circle.findById(circle._id).lean();
      if (!freshCircle || freshCircle.status !== 'active') break;
      circle = freshCircle;

      const now = circleNow(circle);

      const openCycle = await Cycle.findOne({
        circle: circle._id,
        status: 'open',
      }).lean();

      if (!openCycle) break;
      if (new Date(openCycle.closesAt) > now) break;

      const result = await closeCycle(circle, openCycle);
      if (result.skipped) break;

      cyclesClosed++;
      allMissedIds.push(...(result.missedUserIds ?? []));

      if (result.isLastCycle) break;
    }

    summary.push({
      circleId:    circle._id,
      circleName:  circle.name,
      cyclesClosed,
      missedCount: allMissedIds.length,
    });
  }

  return summary;
}
