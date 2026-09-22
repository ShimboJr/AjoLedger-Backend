/**
 * scheduler.js — cron job runner.
 *
 * When ENABLE_CRON=true, uses node-cron to run runEngine then runReminders
 * every 15 minutes. An overlap guard (boolean flag) prevents re-entry if
 * the previous run is still in progress.
 *
 * runJobs() is also exported so the jobs HTTP route can invoke it on demand
 * (e.g., an external pinger on a sleepy free host).
 */

import cron           from 'node-cron';
import { env }        from '../config/env.js';
import { runEngine }  from '../services/engine.js';
import { runReminders } from '../services/reminders.js';

// Overlap guard — prevents concurrent runs
let running = false;

/**
 * runJobs() — run engine + reminders once, with overlap guard.
 * Safe to call from cron or HTTP handler.
 */
export async function runJobs() {
  if (running) {
    console.log('[scheduler] Skipping — previous run still in progress');
    return { skipped: true };
  }

  running = true;
  const startedAt = new Date().toISOString();

  try {
    console.log(`[scheduler] Starting jobs at ${startedAt}`);

    const engineSummary   = await runEngine();
    console.log('[scheduler] Engine:', JSON.stringify(engineSummary));

    const reminderSummary = await runReminders();
    console.log('[scheduler] Reminders:', JSON.stringify(reminderSummary));

    return { engineSummary, reminderSummary, startedAt };
  } catch (err) {
    console.error('[scheduler] Job error:', err.message);
    return { error: err.message, startedAt };
  } finally {
    running = false;
  }
}

/**
 * startScheduler() — wire cron jobs on app startup.
 * Called from server.js. No-ops if ENABLE_CRON=false.
 */
export function startScheduler() {
  if (!env.ENABLE_CRON) {
    console.log('[scheduler] ENABLE_CRON=false — cron jobs disabled');
    return;
  }

  console.log('[scheduler] Starting — runs every 15 minutes');
  cron.schedule('*/15 * * * *', () => {
    runJobs().catch((err) => console.error('[scheduler] Unhandled error:', err.message));
  });
}
