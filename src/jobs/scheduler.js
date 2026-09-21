/**
 * scheduler.js — cron job runner.
 * Wires node-cron jobs: open due cycles, close overdue cycles, send reminders.
 * Implemented on Day 4/5.
 */
import { env } from '../config/env.js';

export function startScheduler() {
  if (!env.ENABLE_CRON) {
    console.log('[scheduler] ENABLE_CRON=false — skipping cron jobs');
    return;
  }
  console.log('[scheduler] Starting cron jobs (stub — Day 4)');
  // TODO Day 4: import and wire cycle engine jobs
}
