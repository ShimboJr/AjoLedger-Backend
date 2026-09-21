/**
 * Money utilities — server side.
 * All amounts in the DB and service layer are integers in kobo.
 * These helpers are only for display/formatting edge cases on the server
 * (e.g., email templates). The UI has its own copy in client/src/utils/money.js.
 */

/**
 * toKobo(naira) — convert naira (number) to kobo (integer).
 * Rounds to nearest integer to avoid floating-point drift.
 */
export function toKobo(naira) {
  return Math.round(naira * 100);
}

/**
 * toNaira(kobo) — convert kobo (integer) to naira (number).
 */
export function toNaira(kobo) {
  return kobo / 100;
}

/**
 * formatNaira(kobo) — human-readable naira string like ₦20,000.
 */
export function formatNaira(kobo) {
  const naira = toNaira(kobo);
  return `₦${naira.toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}
