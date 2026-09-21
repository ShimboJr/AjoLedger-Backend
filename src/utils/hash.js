import { createHash } from 'crypto';

/**
 * sha256(input) — returns hex digest of the SHA-256 hash of input string.
 */
export function sha256(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * hashLedgerEntry — produces the canonical hash for a LedgerEntry.
 * Fields must match the spec in PROJECT_CONTEXT.md §5 LEDGER exactly.
 */
export function hashLedgerEntry({ seq, circle, cycleNumber, user, type, amountKobo, reference, sandbox, createdAt, prevHash }) {
  const canonical = JSON.stringify([
    seq,
    String(circle),
    cycleNumber,
    String(user),
    type,
    amountKobo,
    reference ?? null,
    sandbox,
    createdAt instanceof Date ? createdAt.toISOString() : createdAt,
    prevHash,
  ]);
  return sha256(canonical);
}
