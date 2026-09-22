/**
 * Date utilities — server side.
 * Domain code NEVER calls new Date() directly.
 * Always use circleNow(circle) for time-relative logic.
 */

/**
 * circleNow(circle) — effective "now" for a circle.
 * Returns circle.simulatedNow if set (demo mode), else the real current time.
 */
export function circleNow(circle) {
  return circle?.simulatedNow ? new Date(circle.simulatedNow) : new Date();
}

/**
 * addDays(date, n) — returns a new Date n days after date (UTC-safe).
 */
export function addDays(date, n) {
  return new Date(new Date(date).getTime() + n * 24 * 60 * 60 * 1000);
}

/**
 * addMonths(date, n) — adds n calendar months, clamped to the last day of the
 * target month if the original day doesn't exist there.
 *
 * Examples:
 *   Jan 31 + 1 month → Feb 28/29 (NOT Mar 3)
 *   Jan 31 + 3 months → Apr 30  (April has 30 days)
 *   Jan 15 + 1 month  → Feb 15  (no clamping needed)
 */
export function addMonths(date, n) {
  const d = new Date(date);
  const originalDay = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + n);
  // If JS auto-advanced the month due to day overflow, clamp back to last day.
  // e.g., Jan 31 + 1 → JS makes it Mar 3 (Feb overflow) → setUTCDate(0) → Feb 28/29
  if (d.getUTCDate() !== originalDay) {
    d.setUTCDate(0); // 0 = last day of the previous month
  }
  return d;
}

/**
 * addPeriod(date, frequency) — adds exactly one period.
 * - weekly:   +7 days
 * - biweekly: +14 days
 * - monthly:  +1 calendar month (clamped)
 */
export function addPeriod(date, frequency) {
  return addPeriods(date, frequency, 1);
}

/**
 * addPeriods(startDate, frequency, n) — adds n periods from startDate.
 *
 * IMPORTANT: always computes from the original startDate to avoid drift.
 * e.g., Jan 31, monthly, n=2 → Mar 31 (not Feb 28 + 1 month = Mar 28).
 *
 * This is the canonical function for cycle due-date calculation:
 *   cycle k dueDate = addPeriods(circle.startDate, circle.frequency, k - 1)
 */
export function addPeriods(startDate, frequency, n) {
  if (n === 0) return new Date(startDate);
  const d = new Date(startDate);
  switch (frequency) {
    case 'weekly':
      return new Date(d.getTime() + n * 7 * 24 * 60 * 60 * 1000);
    case 'biweekly':
      return new Date(d.getTime() + n * 14 * 24 * 60 * 60 * 1000);
    case 'monthly':
      return addMonths(d, n);
    default:
      throw new Error(`Unknown frequency: "${frequency}"`);
  }
}
