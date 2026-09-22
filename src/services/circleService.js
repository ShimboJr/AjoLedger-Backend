import mongoose from 'mongoose';
import { Circle } from '../models/Circle.js';
import { Membership } from '../models/Membership.js';
import { Cycle } from '../models/Cycle.js';
import { Obligation } from '../models/Obligation.js';
import { User } from '../models/User.js';
import { generateInviteCode } from '../utils/ids.js';
import { addDays, addPeriods } from '../utils/dates.js';
import { createError } from '../middleware/error.js';
import { env } from '../config/env.js';

// ── Create Circle ────────────────────────────────────────────────────────────

export async function createCircle(userId, data) {
  // Generate a unique invite code with bounded retry
  let inviteCode;
  for (let i = 0; i < 5; i++) {
    const candidate = generateInviteCode();
    const exists = await Circle.findOne({ inviteCode: candidate }).lean();
    if (!exists) { inviteCode = candidate; break; }
  }
  if (!inviteCode) throw createError(500, 'INTERNAL_ERROR', 'Failed to generate a unique invite code');

  const circle = await Circle.create({
    name: data.name,
    organizer: userId,
    contributionKobo: data.contributionKobo,
    frequency: data.frequency,
    maxMembers: data.maxMembers,
    startDate: data.startDate,
    graceDays: data.graceDays,
    status: 'forming',
    inviteCode,
    currentCycleNumber: 0,
    totalCycles: 0,
  });

  // Organizer is position 1, role organizer
  await Membership.create({
    circle: circle._id,
    user: userId,
    position: 1,
    role: 'organizer',
    joinedAt: new Date(),
  });

  const inviteUrl = `${env.CLIENT_URL}/join/${inviteCode}`;
  return { circle, inviteUrl };
}

// ── List my circles ──────────────────────────────────────────────────────────

export async function listMyCircles(userId) {
  const memberships = await Membership.find({ user: userId })
    .populate({ path: 'circle' })
    .lean();

  const result = [];
  for (const m of memberships) {
    const c = m.circle;
    if (!c) continue;

    const memberCount = await Membership.countDocuments({ circle: c._id });

    let nextDueDate = null;
    let myObligationStatus = null;

    if (c.status === 'active') {
      const currentCycle = await Cycle.findOne({
        circle: c._id,
        number: c.currentCycleNumber,
      }).lean();
      nextDueDate = currentCycle?.dueDate ?? null;
      if (currentCycle) {
        const ob = await Obligation.findOne({ cycle: currentCycle._id, user: userId }).lean();
        myObligationStatus = ob?.status ?? null;
      }
    }

    result.push({
      _id: c._id,
      name: c.name,
      status: c.status,
      contributionKobo: c.contributionKobo,
      frequency: c.frequency,
      maxMembers: c.maxMembers,
      memberCount,
      myPosition: m.position,
      myRole: m.role,
      currentCycleNumber: c.currentCycleNumber,
      nextDueDate,
      myObligationStatus,
      // Organizer sees invite code in the list too (for quick access)
      ...(m.role === 'organizer' ? { inviteCode: c.inviteCode } : {}),
    });
  }

  return result;
}

// ── Preview circle by invite code (public, no auth) ──────────────────────────

export async function previewCircle(inviteCode) {
  const circle = await Circle.findOne({ inviteCode }).lean();
  if (!circle) throw createError(404, 'NOT_FOUND', 'Invalid invite link');

  const memberCount = await Membership.countDocuments({ circle: circle._id });
  const organizer = await User.findById(circle.organizer).lean();
  const firstName = organizer?.name?.split(' ')[0] ?? '';

  const joinable = circle.status === 'forming' && memberCount < circle.maxMembers;
  let reason = null;
  if (circle.status !== 'forming') {
    reason = circle.status === 'active' ? 'This circle has already started' : 'This circle has completed';
  } else if (memberCount >= circle.maxMembers) {
    reason = 'This circle is full';
  }

  return {
    circleId: circle._id,
    name: circle.name,
    organizer: { firstName },
    contributionKobo: circle.contributionKobo,
    frequency: circle.frequency,
    maxMembers: circle.maxMembers,
    spotsLeft: Math.max(0, circle.maxMembers - memberCount),
    status: circle.status,
    joinable,
    reason,
  };
}

// ── Join circle by invite code (auth required) ───────────────────────────────

export async function joinByCode(inviteCode, userId) {
  const circle = await Circle.findOne({ inviteCode }).lean();
  if (!circle) throw createError(404, 'NOT_FOUND', 'Invalid invite link');

  if (circle.status !== 'forming') {
    throw createError(400, 'BAD_REQUEST',
      circle.status === 'active' ? 'This circle has already started' : 'This circle has completed');
  }

  // Check already a member BEFORE counting (faster early exit)
  const existing = await Membership.findOne({ circle: circle._id, user: userId }).lean();
  if (existing) throw createError(409, 'CONFLICT', 'You are already a member of this circle');

  const memberCount = await Membership.countDocuments({ circle: circle._id });
  if (memberCount >= circle.maxMembers) {
    throw createError(409, 'CONFLICT', 'This circle is full');
  }

  const nextPosition = memberCount + 1;

  try {
    await Membership.create({
      circle: circle._id,
      user: userId,
      position: nextPosition,
      role: 'member',
      joinedAt: new Date(),
    });
  } catch (err) {
    if (err.code === 11000) {
      // Race condition: the last spot was just taken by another request
      throw createError(409, 'CONFLICT', 'This circle just filled up. Try another circle or ask the organizer to expand.');
    }
    throw err;
  }

  return { circleId: circle._id, position: nextPosition };
}

// ── Get circle detail (members only → others get 404) ────────────────────────

export async function getCircleDetail(circleId, userId) {
  // Authorization: non-members see a 404 (not 403) to avoid leaking existence
  const myMembership = await Membership.findOne({ circle: circleId, user: userId }).lean();
  if (!myMembership) throw createError(404, 'NOT_FOUND', 'Circle not found');

  const circle = await Circle.findById(circleId).lean();
  if (!circle) throw createError(404, 'NOT_FOUND', 'Circle not found');

  const isOrganizer = String(circle.organizer) === String(userId);

  // All members ordered by position
  const members = await Membership.find({ circle: circleId })
    .populate('user', 'name')
    .sort({ position: 1 })
    .lean();

  // Current cycle, obligations
  let currentCycle = null;
  let myObligation = null;
  let obligations = [];

  if (circle.status !== 'forming') {
    currentCycle = await Cycle.findOne({ circle: circleId, number: circle.currentCycleNumber })
      .populate('recipient', 'name')
      .lean();

    if (currentCycle) {
      currentCycle.expectedPotKobo = members.length * circle.contributionKobo;
      myObligation = await Obligation.findOne({ cycle: currentCycle._id, user: userId }).lean();
      obligations = await Obligation.find({ cycle: currentCycle._id })
        .populate('user', 'name')
        .lean();
    }
  }

  // Sanitise: only organizer sees inviteCode
  const circleData = { ...circle };
  if (!isOrganizer) delete circleData.inviteCode;

  return {
    circle: circleData,
    members,
    currentCycle,
    myObligation,
    obligations,
    myRole: myMembership.role,
    myPosition: myMembership.position,
    isOrganizer,
  };
}

// ── Reorder payout positions (organizer, forming only) ───────────────────────

export async function updatePayoutOrder(circleId, userId, orderUserIds) {
  const circle = await Circle.findById(circleId).lean();
  if (!circle) throw createError(404, 'NOT_FOUND', 'Circle not found');
  if (String(circle.organizer) !== String(userId)) {
    throw createError(403, 'FORBIDDEN', 'Only the organizer can reorder members');
  }
  if (circle.status !== 'forming') {
    throw createError(400, 'BAD_REQUEST', 'Payout order can only be changed while forming');
  }

  const memberships = await Membership.find({ circle: circleId }).lean();
  const memberUserIds = memberships.map((m) => String(m.user));

  // Validate: must be exactly the same set of member user IDs
  if (orderUserIds.length !== memberUserIds.length) {
    throw createError(422, 'VALIDATION_ERROR', `Order must contain exactly ${memberUserIds.length} members`);
  }
  const incoming = [...orderUserIds].sort();
  const current = [...memberUserIds].sort();
  if (!incoming.every((id, i) => id === current[i])) {
    throw createError(422, 'VALIDATION_ERROR', 'Order contains unknown or missing members');
  }

  // Two-phase reorder using a session to satisfy the unique (circle, position) constraint:
  //   Phase 1: shift all positions to safe temp values (position + 1000) so 1-N don't conflict
  //   Phase 2: write the final positions 1-N
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // Phase 1 — temp positions (1001-1012, safe range)
      for (const m of memberships) {
        await Membership.updateOne(
          { _id: m._id },
          { $set: { position: 1000 + m.position } },
          { session }
        );
      }
      // Phase 2 — final positions
      for (let i = 0; i < orderUserIds.length; i++) {
        await Membership.updateOne(
          { circle: circleId, user: orderUserIds[i] },
          { $set: { position: i + 1 } },
          { session }
        );
      }
    });
  } finally {
    await session.endSession();
  }
}

// ── Start circle (organizer, forming, ≥2 members) ─────────────────────────────

export async function startCircle(circleId, userId) {
  const circle = await Circle.findById(circleId).lean();
  if (!circle) throw createError(404, 'NOT_FOUND', 'Circle not found');
  if (String(circle.organizer) !== String(userId)) {
    throw createError(403, 'FORBIDDEN', 'Only the organizer can start the circle');
  }
  if (circle.status !== 'forming') {
    throw createError(400, 'BAD_REQUEST', 'Circle is not in forming status');
  }

  const memberships = await Membership.find({ circle: circleId })
    .sort({ position: 1 })
    .lean();

  if (memberships.length < 2) {
    throw createError(400, 'BAD_REQUEST', 'At least 2 members are required to start a circle');
  }

  const n = memberships.length;
  const startDate = new Date(circle.startDate);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // 1. Update circle status
      await Circle.updateOne(
        { _id: circleId },
        { $set: { status: 'active', totalCycles: n, currentCycleNumber: 1 } },
        { session }
      );

      // 2. Create all cycles (cycle 1 = open, rest = scheduled)
      //    dueDate for cycle k = startDate + (k-1) periods
      const cycleDocs = memberships.map((m, idx) => {
        const dueDate = addPeriods(startDate, circle.frequency, idx);
        const closesAt = addDays(dueDate, circle.graceDays);
        return {
          circle: circleId,
          number: idx + 1,
          dueDate,
          closesAt,
          recipient: m.user,
          status: idx === 0 ? 'open' : 'scheduled',
          potKobo: 0,
        };
      });

      const createdCycles = await Cycle.insertMany(cycleDocs, { session });

      // 3. Create obligations for cycle 1 (one per member)
      const cycle1 = createdCycles.find((c) => c.number === 1);
      const obligationDocs = memberships.map((m) => ({
        circle: circleId,
        cycle: cycle1._id,
        cycleNumber: 1,
        user: m.user,
        amountKobo: circle.contributionKobo,
        status: 'pending',
      }));

      await Obligation.insertMany(obligationDocs, { session });
    });
  } finally {
    await session.endSession();
  }

  return Circle.findById(circleId).lean();
}
