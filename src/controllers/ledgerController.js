/**
 * ledgerController.js
 *
 * GET /api/circles/:id/ledger         — cursor-paginated ledger entries (members only)
 * GET /api/circles/:id/ledger/verify  — re-verify the hash chain (members only)
 */

import { LedgerEntry } from '../models/LedgerEntry.js';
import { Membership }  from '../models/Membership.js';
import { verifyChain } from '../services/ledger.js';
import { createError } from '../middleware/error.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT     = 50;

// ── Authorization helper ──────────────────────────────────────────────────────

async function requireMember(circleId, userId) {
  const m = await Membership.findOne({ circle: circleId, user: userId }).lean();
  if (!m) throw createError(404, 'NOT_FOUND', 'Circle not found');
}

// ── GET /api/circles/:id/ledger ───────────────────────────────────────────────

export async function handleListLedger(req, res, next) {
  try {
    const circleId = req.params.id;
    await requireMember(circleId, req.user._id);

    const limit  = Math.min(Number(req.query.limit) || DEFAULT_LIMIT, MAX_LIMIT);
    const cursor = req.query.cursor ? Number(req.query.cursor) : null;

    // Paginate ascending by seq; cursor = last seen seq
    const filter = { circle: circleId };
    if (cursor !== null && !isNaN(cursor)) filter.seq = { $gt: cursor };

    const entries = await LedgerEntry.find(filter)
      .sort({ seq: 1 })
      .limit(limit + 1)         // fetch one extra to detect hasMore
      .populate('user', 'name') // member display name
      .lean();

    const hasMore    = entries.length > limit;
    const page       = hasMore ? entries.slice(0, limit) : entries;
    const nextCursor = hasMore ? page[page.length - 1].seq : null;

    return res.json({ data: { entries: page, nextCursor, hasMore } });
  } catch (err) { next(err); }
}

// ── GET /api/circles/:id/ledger/verify ───────────────────────────────────────

export async function handleVerifyLedger(req, res, next) {
  try {
    const circleId = req.params.id;
    await requireMember(circleId, req.user._id);

    const result = await verifyChain(circleId);

    return res.json({ data: result });
  } catch (err) { next(err); }
}
