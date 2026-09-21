/**
 * Date utilities — server side.
 * Domain code should never call new Date() directly.
 * Use circleNow(circle) for all time-relative logic.
 */

/**
 * circleNow(circle) — returns the effective "now" for a circle.
 * If the circle has a simulatedNow set (demo mode), returns that.
 * Otherwise returns the real current time.
 */
export function circleNow(circle) {
  return circle?.simulatedNow ?? new Date();
}

/**
 * addDays(date, n) — returns a new Date that is n days after date.
 */
export function addDays(date, n) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + n);
  return result;
}

/**
 * addCalendarMonth(date) — adds one calendar month, clamped to end of month.
 * e.g., Jan 31 → Feb 28/29.
 */
export function addCalendarMonth(date) {
  const d = new Date(date);
  const targetMonth = d.getUTCMonth() + 1;
  d.setUTCMonth(targetMonth);
  // If month overflowed (e.g., Mar 31 → Apr 31 → May 1), clamp back
  if (d.getUTCMonth() !== targetMonth % 12) {
    d.setUTCDate(0); // last day of the intended month
  }
  return d;
}

/**
 * nextCycleDueDate(currentDueDate, frequency) — compute next cycle due date.
 */
export function nextCycleDueDate(currentDueDate, frequency) {
  switch (frequency) {
    case 'weekly':   return addDays(currentDueDate, 7);
    case 'biweekly': return addDays(currentDueDate, 14);
    case 'monthly':  return addCalendarMonth(currentDueDate);
    default: throw new Error(`Unknown frequency: ${frequency}`);
  }
}
