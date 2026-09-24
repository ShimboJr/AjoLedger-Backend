/**
 * reminders.js — send in-app and email reminders for pending obligations.
 *
 * runReminders({ circleId? })
 *   For each open cycle and each pending obligation, classifies:
 *     'due_soon'  — now >= dueDate - REMINDER_DAYS_BEFORE AND before dueDate (not same day)
 *     'due_today' — same calendar day as dueDate
 *     'overdue'   — after dueDate AND before closesAt
 *   Creates an in-app Notification AND sends an email for each matching kind.
 *   dedupeKey = rem:{kind}:{obligationId} (unique index) ensures it never sends twice.
 *
 *   Also picks up un-emailed engine notifications (payment_missed, payout_sent)
 *   and sends emails for them, storing emailStatus on the Notification.
 */

import { Circle }       from '../models/Circle.js';
import { Cycle }        from '../models/Cycle.js';
import { Obligation }   from '../models/Obligation.js';
import { Notification } from '../models/Notification.js';
import { User }         from '../models/User.js';
import { circleNow }    from '../utils/dates.js';
import { env }          from '../config/env.js';
import { sendCircleMail } from './mailerService.js';

// ── Reminder classification ───────────────────────────────────────────────────

function isSameUTCDay(a, b) {
  const da = new Date(a), db = new Date(b);
  return (
    da.getUTCFullYear() === db.getUTCFullYear() &&
    da.getUTCMonth()    === db.getUTCMonth()    &&
    da.getUTCDate()     === db.getUTCDate()
  );
}

/**
 * classifyReminders(now, dueDate, closesAt, reminderDaysBefore)
 * Returns an array of applicable reminder kinds for this point in time.
 * Multiple kinds can be active simultaneously and are each deduped independently.
 */
function classifyReminders(now, dueDate, closesAt, reminderDaysBefore) {
  const nowMs    = now.getTime();
  const dueMs    = new Date(dueDate).getTime();
  const closeMs  = new Date(closesAt).getTime();
  const windowMs = dueMs - reminderDaysBefore * 24 * 60 * 60 * 1000;

  const kinds = [];

  // overdue: strictly after dueDate, before closesAt
  if (nowMs > dueMs && nowMs < closeMs) {
    kinds.push('overdue');
  }

  // due_today: same UTC calendar day as dueDate (even if past dueDate time — handled above)
  if (!kinds.includes('overdue') && isSameUTCDay(now, new Date(dueDate))) {
    kinds.push('due_today');
  }

  // due_soon: within reminder window but before dueDate, and not the same day
  if (
    nowMs >= windowMs &&
    nowMs < dueMs &&
    !isSameUTCDay(now, new Date(dueDate))
  ) {
    kinds.push('due_soon');
  }

  return kinds;
}

// ── Notification helper (deduped) ─────────────────────────────────────────────

async function tryCreateNotification(data) {
  try {
    return await Notification.create(data);
  } catch (err) {
    if (err.code === 11000) return null; // Already sent — expected
    console.error('[reminders] Notification create error:', err.message);
    return null;
  }
}

// ── Reminder copy ─────────────────────────────────────────────────────────────

const REMINDER_COPY = {
  due_soon: (amountNaira, circleName, days) => ({
    title: `Contribution due in ${days} day${days !== 1 ? 's' : ''}`,
    body:  `Your contribution of ${amountNaira} for "${circleName}" is coming up soon. Please pay before the due date.`,
  }),
  due_today: (amountNaira, circleName) => ({
    title: 'Contribution due today',
    body:  `Your contribution of ${amountNaira} for "${circleName}" is due today. Pay now to stay on time.`,
  }),
  overdue: (amountNaira, circleName) => ({
    title: 'Contribution overdue',
    body:  `Your contribution of ${amountNaira} for "${circleName}" is overdue. Pay now before the window closes to avoid being marked as missed.`,
  }),
};

function formatNaira(kobo) {
  return `₦${(kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
}

// ── runReminders ──────────────────────────────────────────────────────────────

/**
 * runReminders({ circleId? }) — process reminders for all (or one) circles.
 *
 * @param {{ circleId?: string }} [options]
 * @returns {Promise<{ notificationsCreated: number, emailsSent: number }>}
 */
export async function runReminders({ circleId } = {}) {
  // When targeting a specific circle, also match 'completed' — the engine
  // transitions the circle to 'completed' when the last cycle closes, which
  // happens BEFORE runReminders is called.  Without this, the final cycle's
  // emails (payout_sent, payment_missed, circle_completed) are never sent.
  const circleQuery = circleId
    ? { _id: circleId, status: { $in: ['active', 'completed'] } }
    : { status: 'active' };

  const circles = await Circle.find(circleQuery).lean();

  let notificationsCreated = 0;
  let emailsSent = 0;

  for (const circle of circles) {
    const now = circleNow(circle);

    const openCycle = await Cycle.findOne({ circle: circle._id, status: 'open' }).lean();

    // ── Part 1: Pending obligation reminders ─────────────────────────────────
    // Only runs when there is an open cycle.  When the circle is 'completed'
    // (last cycle just closed) there are no pending obligations to remind about.

    if (openCycle) {
      const obligations = await Obligation.find({
        cycle:  openCycle._id,
        status: 'pending',
      }).lean();

      for (const ob of obligations) {
        const kinds = classifyReminders(
          now,
          openCycle.dueDate,
          openCycle.closesAt,
          env.REMINDER_DAYS_BEFORE
        );

        if (kinds.length === 0) continue;

        const user = await User.findById(ob.user).lean();
        if (!user) continue;

        const amountNaira = formatNaira(ob.amountKobo);

        for (const kind of kinds) {
          const copyFn = REMINDER_COPY[kind];
          if (!copyFn) continue;

          const { title, body } = copyFn(amountNaira, circle.name, env.REMINDER_DAYS_BEFORE);
          const dedupeKey = `rem:${kind}:${ob._id}`;

          // Create in-app notification (deduped by unique index on dedupeKey)
          const notification = await tryCreateNotification({
            user:        ob.user,
            circle:      circle._id,
            kind:        'reminder',
            title,
            body,
            dedupeKey,
            emailStatus: 'skipped', // Will update after email attempt
          });

          if (!notification) continue; // Already sent — skip email too
          notificationsCreated++;

          // Send email
          const result = await sendCircleMail({
            to:         user.email,
            subject:    title,
            title,
            body,
            circleName: circle.name,
            amountKobo: ob.amountKobo,
            dueDate:    openCycle.dueDate,
            circleId:   circle._id,
          });

          await Notification.updateOne(
            { _id: notification._id },
            { $set: { emailStatus: result.status } }
          );

          if (result.status === 'sent') emailsSent++;
        }
      }
    }

    // ── Part 2: Send emails for undelivered engine notifications ──────────────
    // Runs regardless of whether there is an open cycle so that notifications
    // created for the final cycle (payment_missed, payout_sent, circle_completed)
    // are emailed even after the circle has transitioned to 'completed'.

    const pendingEngineNotifs = await Notification.find({
      circle:      circle._id,
      // Include circle_completed — engine creates these for every member when
      // the last cycle closes, but they were never in this pickup list.
      kind:        { $in: ['payment_missed', 'payout_sent', 'circle_completed'] },
      emailStatus: 'skipped',
    }).lean();

    for (const notif of pendingEngineNotifs) {
      const user = await User.findById(notif.user).lean();
      if (!user?.email) continue;

      const result = await sendCircleMail({
        to:         user.email,
        subject:    notif.title,
        title:      notif.title,
        body:       notif.body,
        circleName: circle.name,
        circleId:   circle._id,
      });

      await Notification.updateOne(
        { _id: notif._id },
        { $set: { emailStatus: result.status } }
      );

      if (result.status === 'sent') emailsSent++;
    }
  }

  return { notificationsCreated, emailsSent };
}
