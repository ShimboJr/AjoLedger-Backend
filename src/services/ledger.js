/**
 * ledger.js — append-only, hash-chained ledger operations.
 *
 * appendLedgerEntry(session, data)
 *   • Must be called from within an already-open Mongoose transaction session.
 *   • Reads the current tail (within the transaction), computes seq + prevHash,
 *     hashes the entry per hash.js canonical order, and inserts it.
 *   • Does NOT retry internally — retry belongs at the transaction level (see settlePayment).
 *
 * verifyChain(circleId)
 *   • Reads every entry in seq order (no session needed — read-only).
 *   • Re-computes each hash, checks prevHash links, checks for gaps.
 *   • Returns { ok, checked, brokenAtSeq?, reason? }.
 */

import { LedgerEntry } from '../models/LedgerEntry.js';
import { hashLedgerEntry } from '../utils/hash.js';

// ── Append ───────────────────────────────────────────────────────────────────

/**
 * appendLedgerEntry — insert one ledger entry atomically within a transaction.
 *
 * @param {import('mongoose').ClientSession} session - active Mongoose session
 * @param {object} data
 * @param {*}      data.circle      - circle ObjectId
 * @param {*}      data.cycle       - cycle ObjectId
 * @param {number} data.cycleNumber
 * @param {string} data.type        - 'contribution' | 'payout' | 'missed'
 * @param {*}      data.user        - user ObjectId
 * @param {number} data.amountKobo  - integer kobo
 * @param {string} [data.reference] - Paystack reference
 * @param {object} [data.meta]      - arbitrary extra metadata
 * @returns {Promise<object>} the inserted lean document
 */
export async function appendLedgerEntry(session, data) {
  // Read the current tail within the transaction to get the latest seq + hash.
  // Using .session(session) ensures consistency under snapshot isolation.
  const last = await LedgerEntry.findOne({ circle: data.circle })
    .sort({ seq: -1 })
    .session(session)
    .lean();

  const seq      = last ? last.seq + 1 : 1;
  const prevHash = last ? last.hash : 'GENESIS';

  // createdAt must be set now so it's included in the hash BEFORE insert.
  const createdAt = new Date();

  const hash = hashLedgerEntry({
    seq,
    circle:      data.circle,
    cycleNumber: data.cycleNumber,
    user:        data.user,
    type:        data.type,
    amountKobo:  data.amountKobo,
    reference:   data.reference ?? null,
    sandbox:     true, // always sandbox in the current build
    createdAt,
    prevHash,
  });

  // create([ doc ], { session }) is the Mongoose pattern for transactional inserts.
  // IMPORTANT: omit 'reference' entirely (not null) when absent — the sparse unique
  // index on reference_1 treats null as a present value and conflicts on multiple nulls.
  const docFields = {
    seq,
    circle:      data.circle,
    cycle:       data.cycle,
    cycleNumber: data.cycleNumber,
    type:        data.type,
    user:        data.user,
    amountKobo:  data.amountKobo,
    sandbox:     true,
    meta:        data.meta ?? {},
    prevHash,
    hash,
    createdAt,
  };
  if (data.reference != null) docFields.reference = data.reference;

  const [entry] = await LedgerEntry.create([docFields], { session });

  return entry;
}

// ── Verify ───────────────────────────────────────────────────────────────────

/**
 * verifyChain — re-verify every ledger entry for a circle.
 *
 * @param {string|import('mongoose').Types.ObjectId} circleId
 * @returns {Promise<{ ok: boolean, checked: number, brokenAtSeq?: number, reason?: string }>}
 */
export async function verifyChain(circleId) {
  // Fetch all entries in ascending seq order
  const entries = await LedgerEntry.find({ circle: circleId })
    .sort({ seq: 1 })
    .lean();

  if (entries.length === 0) return { ok: true, checked: 0 };

  let expectedPrevHash = 'GENESIS';

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];

    // 1. Sequence gap check
    if (e.seq !== i + 1) {
      return {
        ok: false,
        checked: i,
        brokenAtSeq: e.seq,
        reason: `Gap: expected seq ${i + 1}, found ${e.seq}`,
      };
    }

    // 2. prevHash link check
    if (e.prevHash !== expectedPrevHash) {
      return {
        ok: false,
        checked: i,
        brokenAtSeq: e.seq,
        reason: `prevHash mismatch at seq ${e.seq}`,
      };
    }

    // 3. Hash integrity check — recompute from stored fields
    const computed = hashLedgerEntry({
      seq:         e.seq,
      circle:      e.circle,
      cycleNumber: e.cycleNumber,
      user:        e.user,
      type:        e.type,
      amountKobo:  e.amountKobo,
      reference:   e.reference ?? null,
      sandbox:     e.sandbox,
      createdAt:   e.createdAt,
      prevHash:    e.prevHash,
    });

    if (computed !== e.hash) {
      return {
        ok: false,
        checked: i,
        brokenAtSeq: e.seq,
        reason: `Hash mismatch at seq ${e.seq}`,
      };
    }

    expectedPrevHash = e.hash;
  }

  return { ok: true, checked: entries.length };
}
