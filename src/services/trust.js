/**
 * trust.js — reliability score computation and trust profile management.
 *
 * scoreFromCounts({ onTime, late, missed }) — pure function.
 *   Weights: on-time=1, late=0.5, missed=0.
 *   Tiers: excellent ≥90, good ≥70, fair ≥50, poor <50.
 *   Returns { score: null, tier: 'building' } when resolved < 3.
 *
 * computeTrust(userId) — aggregate a user's obligations across all circles.
 *   Returns { score, tier, onTime, late, missed, resolved,
 *             circlesJoined, circlesCompleted, memberSince }
 *
 * getTrustProfile(userId) — extends computeTrust with { slug, isPublic, publicUrl }.
 *   Lazy-backfills the slug if the user has none.
 *
 * updateTrustSettings(userId, { isPublic?, regenerateSlug? }) — PATCH handler.
 */

import { Obligation } from '../models/Obligation.js';
import { Membership } from '../models/Membership.js';
import { Circle }     from '../models/Circle.js';
import { User }       from '../models/User.js';
import { generateTrustSlug } from '../utils/ids.js';
import { env }        from '../config/env.js';

const MIN_RESOLVED = 3;

// ── Pure scoring function ─────────────────────────────────────────────────────

/**
 * scoreFromCounts({ onTime, late, missed }) — pure, synchronous.
 *
 * @param {{ onTime: number, late: number, missed: number }} counts
 * @returns {{ score: number|null, tier: string, resolved: number }}
 */
export function scoreFromCounts({ onTime, late, missed }) {
  const resolved = onTime + late + missed;

  if (resolved < MIN_RESOLVED) {
    return { score: null, tier: 'building', resolved };
  }

  const raw   = ((onTime * 1 + late * 0.5) / resolved) * 100;
  const score = Math.round(raw * 10) / 10; // 1 decimal place

  let tier;
  if      (score >= 90) tier = 'excellent';
  else if (score >= 70) tier = 'good';
  else if (score >= 50) tier = 'fair';
  else                  tier = 'poor';

  return { score, tier, resolved };
}

// ── Tier display helpers ──────────────────────────────────────────────────────

export const TIER_LABELS = {
  excellent: 'Exceptional — always pays on time',
  good:      'Reliable — rarely misses',
  fair:      'Developing — occasional delays',
  poor:      'Needs improvement',
  building:  'Building your history',
};

// ── Slug helpers ──────────────────────────────────────────────────────────────

/**
 * ensureSlug(userId) — lazy-backfill. Generates + saves a slug if the user
 * has none. Returns the slug (existing or new).
 *
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @returns {Promise<string>}
 */
export async function ensureSlug(userId) {
  const user = await User.findById(userId).select('trust').lean();
  if (user?.trust?.slug) return user.trust.slug;

  // Try up to 5 times in case of a duplicate (birthday-problem unlikely at this scale)
  for (let i = 0; i < 5; i++) {
    const slug = generateTrustSlug();
    try {
      await User.updateOne(
        { _id: userId, 'trust.slug': { $exists: false } },
        { $set: { 'trust.slug': slug } }
      );
      // Re-fetch to get the actual saved slug (in case of concurrent update)
      const fresh = await User.findById(userId).select('trust').lean();
      return fresh?.trust?.slug ?? slug;
    } catch (err) {
      if (err.code === 11000) continue; // Slug collision — retry
      throw err;
    }
  }
  throw new Error('Failed to generate a unique trust slug');
}

// ── computeTrust ──────────────────────────────────────────────────────────────

/**
 * computeTrust(userId) — aggregate trust data for one user.
 *
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @returns {Promise<{
 *   score: number|null, tier: string, onTime: number, late: number,
 *   missed: number, resolved: number, circlesJoined: number,
 *   circlesCompleted: number, memberSince: Date|null
 * }>}
 */
export async function computeTrust(userId) {
  const [user, obligations, memberships] = await Promise.all([
    User.findById(userId).lean(),
    Obligation.find({
      user:   userId,
      status: { $in: ['paid_on_time', 'paid_late', 'missed'] },
    }).lean(),
    Membership.find({ user: userId }).lean(),
  ]);

  const onTime = obligations.filter((o) => o.status === 'paid_on_time').length;
  const late   = obligations.filter((o) => o.status === 'paid_late').length;
  const missed = obligations.filter((o) => o.status === 'missed').length;

  const { score, tier, resolved } = scoreFromCounts({ onTime, late, missed });

  const circlesJoined = memberships.length;
  const circleIds     = memberships.map((m) => m.circle);

  const circlesCompleted = circleIds.length
    ? await Circle.countDocuments({ _id: { $in: circleIds }, status: 'completed' })
    : 0;

  return {
    score,
    tier,
    label:   TIER_LABELS[tier] ?? tier,
    onTime,
    late,
    missed,
    resolved,
    circlesJoined,
    circlesCompleted,
    memberSince: user?.createdAt ?? null,
  };
}

// ── getTrustProfile ───────────────────────────────────────────────────────────

/**
 * getTrustProfile(userId) — full profile including slug + public settings.
 * Lazy-backfills the slug if missing.
 *
 * @param {string|import('mongoose').Types.ObjectId} userId
 */
export async function getTrustProfile(userId) {
  const [trust, user, slug] = await Promise.all([
    computeTrust(userId),
    User.findById(userId).select('trust').lean(),
    ensureSlug(userId),
  ]);

  const isPublic  = user?.trust?.isPublic ?? false;
  const publicUrl = `${env.CLIENT_URL}/t/${slug}`;

  return {
    ...trust,
    slug,
    isPublic,
    publicUrl,
  };
}

// ── updateTrustSettings ───────────────────────────────────────────────────────

/**
 * updateTrustSettings(userId, { isPublic?, regenerateSlug? })
 *
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {{ isPublic?: boolean, regenerateSlug?: boolean }} opts
 * @returns {Promise<{ slug: string, isPublic: boolean, publicUrl: string }>}
 */
export async function updateTrustSettings(userId, { isPublic, regenerateSlug } = {}) {
  const update = {};

  if (typeof isPublic === 'boolean') {
    update['trust.isPublic'] = isPublic;
  }

  if (regenerateSlug) {
    // Generate new slug — old link is immediately invalidated
    for (let i = 0; i < 5; i++) {
      const newSlug = generateTrustSlug();
      try {
        await User.updateOne({ _id: userId }, { $set: { 'trust.slug': newSlug, ...update } });
        const publicUrl = `${env.CLIENT_URL}/t/${newSlug}`;
        const fresh = await User.findById(userId).select('trust').lean();
        return { slug: newSlug, isPublic: fresh?.trust?.isPublic ?? false, publicUrl };
      } catch (err) {
        if (err.code === 11000) continue;
        throw err;
      }
    }
    throw new Error('Failed to generate a unique trust slug');
  }

  if (Object.keys(update).length > 0) {
    await User.updateOne({ _id: userId }, { $set: update });
  }

  const fresh = await User.findById(userId).select('trust').lean();
  const slug  = await ensureSlug(userId);
  return {
    slug,
    isPublic:  fresh?.trust?.isPublic ?? false,
    publicUrl: `${env.CLIENT_URL}/t/${slug}`,
  };
}
