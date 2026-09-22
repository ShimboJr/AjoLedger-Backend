/**
 * jobs.js — routes under /api/jobs
 *
 * POST /api/jobs/run
 *   Validates the x-cron-secret header using a timing-safe comparison.
 *   On success, runs runEngine then runReminders and returns their summaries.
 *   Use this so an external pinger (e.g., cron-job.org) can drive jobs on
 *   sleepy free hosts that don't keep processes alive.
 */

import { Router }          from 'express';
import { timingSafeEqual } from 'crypto';
import { env }             from '../config/env.js';
import { runEngine }       from '../services/engine.js';
import { runReminders }    from '../services/reminders.js';

const router = Router();

/**
 * POST /api/jobs/run
 * Header: x-cron-secret: <CRON_SECRET>
 */
router.post('/run', async (req, res, next) => {
  try {
    const provided = req.headers['x-cron-secret'] ?? '';
    const expected  = env.CRON_SECRET;

    // timingSafeEqual requires same-length buffers; we compare byte-by-byte
    // and also verify original string lengths to defeat padding attacks.
    const valid =
      provided.length === expected.length &&
      timingSafeEqual(
        Buffer.from(provided, 'utf8'),
        Buffer.from(expected, 'utf8')
      );

    if (!valid) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Invalid or missing x-cron-secret' },
      });
    }

    // Run sequentially: engine first so payment_missed / payout_sent notifications
    // are created, then reminders picks them up to send emails.
    const engineSummary   = await runEngine();
    const reminderSummary = await runReminders();

    res.json({
      data: {
        engine:    engineSummary,
        reminders: reminderSummary,
        ranAt:     new Date().toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
