/**
 * engine.test.js — vitest suite for:
 *  1. scoreFromCounts (pure function, table tests)
 *  2. Engine idempotency (closeCycle twice → no duplicate ledger/notifications)
 *  3. Close with missed member → correct entries, cycle 2 open, shortfall
 *  4. Reminder dedupe (runReminders twice → single notification per kind)
 *  5. POST /api/jobs/run — rejects bad secret, accepts correct one
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import supertest from 'supertest';
import mongoose  from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import { scoreFromCounts }      from '../src/services/trust.js';
import { runEngine, closeCycle } from '../src/services/engine.js';
import { runReminders }          from '../src/services/reminders.js';
import { Circle }                from '../src/models/Circle.js';
import { Cycle }                 from '../src/models/Cycle.js';
import { Obligation }            from '../src/models/Obligation.js';
import { Membership }            from '../src/models/Membership.js';
import { LedgerEntry }           from '../src/models/LedgerEntry.js';
import { Notification }          from '../src/models/Notification.js';
import { User }                  from '../src/models/User.js';

// ── Test DB setup ─────────────────────────────────────────────────────────────

let replSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri();
  await mongoose.connect(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 10_000 });
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet.stop();
}, 30_000);

afterEach(async () => {
  const cols = mongoose.connection.collections;
  for (const col of Object.values(cols)) await col.deleteMany({});
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeUser(overrides = {}) {
  return User.create({
    name:         overrides.name  ?? `User-${Math.random().toString(36).slice(2, 6)}`,
    email:        overrides.email ?? `${Math.random().toString(36).slice(2, 10)}@test.local`,
    passwordHash: 'hashed',
  });
}

/**
 * Set up a fresh circle with 3 members and cycle 1 already OPEN with a
 * closesAt in the past (so the engine will close it) but an optional override
 * to keep closesAt in the future (for reminder tests).
 */
async function makeActiveCircle({ futureClosesAt = false } = {}) {
  const org  = await makeUser({ name: 'Organizer' });
  const mem1 = await makeUser({ name: 'Member-1' });
  const mem2 = await makeUser({ name: 'Member-2' });

  const past = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);

  const circle = await Circle.create({
    name:               'Engine Test Circle',
    organizer:          org._id,
    contributionKobo:   50_000,
    frequency:          'monthly',
    maxMembers:         3,
    startDate:          past,
    graceDays:          2,
    status:             'active',
    inviteCode:         `eng${Math.random().toString(36).slice(2, 8)}`,
    currentCycleNumber: 1,
    totalCycles:        3,
  });

  await Membership.create([
    { circle: circle._id, user: org._id,  position: 1, role: 'organizer', joinedAt: past },
    { circle: circle._id, user: mem1._id, position: 2, role: 'member',    joinedAt: past },
    { circle: circle._id, user: mem2._id, position: 3, role: 'member',    joinedAt: past },
  ]);

  const dueDate  = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // 5 days ago
  const closesAt = futureClosesAt
    ? new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)  // 5 days from now
    : new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // 3 days ago

  const cycle1 = await Cycle.create({
    circle: circle._id, number: 1, dueDate, closesAt,
    recipient: org._id, status: 'open', potKobo: 0,
  });

  // Cycle 2 (scheduled, future)
  await Cycle.create({
    circle: circle._id, number: 2,
    dueDate:  new Date(Date.now() + 25 * 24 * 60 * 60 * 1000),
    closesAt: new Date(Date.now() + 27 * 24 * 60 * 60 * 1000),
    recipient: mem1._id, status: 'scheduled', potKobo: 0,
  });

  // Cycle 3 (scheduled, future)
  await Cycle.create({
    circle: circle._id, number: 3,
    dueDate:  new Date(Date.now() + 55 * 24 * 60 * 60 * 1000),
    closesAt: new Date(Date.now() + 57 * 24 * 60 * 60 * 1000),
    recipient: mem2._id, status: 'scheduled', potKobo: 0,
  });

  // Pending obligations for cycle 1
  await Obligation.create([
    { circle: circle._id, cycle: cycle1._id, cycleNumber: 1, user: org._id,  amountKobo: 50_000, status: 'pending' },
    { circle: circle._id, cycle: cycle1._id, cycleNumber: 1, user: mem1._id, amountKobo: 50_000, status: 'pending' },
    { circle: circle._id, cycle: cycle1._id, cycleNumber: 1, user: mem2._id, amountKobo: 50_000, status: 'pending' },
  ]);

  return { circle: circle.toObject(), cycle1: cycle1.toObject(), org, mem1, mem2 };
}

// ── 1. scoreFromCounts ────────────────────────────────────────────────────────

describe('scoreFromCounts', () => {
  it('returns building + null score when resolved < 3', () => {
    const cases = [
      { onTime: 0, late: 0, missed: 0 },
      { onTime: 1, late: 0, missed: 0 },
      { onTime: 0, late: 2, missed: 0 },
      { onTime: 1, late: 1, missed: 0 },
    ];
    for (const c of cases) {
      const r = scoreFromCounts(c);
      expect(r.tier, `tier for ${JSON.stringify(c)}`).toBe('building');
      expect(r.score, `score for ${JSON.stringify(c)}`).toBeNull();
    }
  });

  it('exactly 3 resolved cases resolve to a tier', () => {
    expect(scoreFromCounts({ onTime: 3, late: 0, missed: 0 }).tier).toBe('excellent'); // 100%
    expect(scoreFromCounts({ onTime: 0, late: 0, missed: 3 }).tier).toBe('poor');      // 0%
  });

  it('excellent (≥90%): 10 on time, 0 late, 0 missed → 100', () => {
    const r = scoreFromCounts({ onTime: 10, late: 0, missed: 0 });
    expect(r.tier).toBe('excellent');
    expect(r.score).toBe(100);
  });

  it('good (70–89%): 7 on time, 0 late, 3 missed → 70', () => {
    const r = scoreFromCounts({ onTime: 7, late: 0, missed: 3 });
    expect(r.tier).toBe('good');
    expect(r.score).toBe(70);
  });

  it('fair (50–69%): 0 on time, 6 late, 0 missed → 50', () => {
    const r = scoreFromCounts({ onTime: 0, late: 6, missed: 0 });
    expect(r.tier).toBe('fair');
    expect(r.score).toBe(50);
  });

  it('poor (<50%): 0 on time, 0 late, 5 missed → 0', () => {
    const r = scoreFromCounts({ onTime: 0, late: 0, missed: 5 });
    expect(r.tier).toBe('poor');
    expect(r.score).toBe(0);
  });

  it('mixed: 9 on time, 1 late, 0 missed → 95 excellent', () => {
    const r = scoreFromCounts({ onTime: 9, late: 1, missed: 0 });
    expect(r.score).toBe(95);
    expect(r.tier).toBe('excellent');
  });
});

// ── 2. Engine idempotency ─────────────────────────────────────────────────────

describe('Engine idempotency', () => {
  it('running closeCycle twice creates no duplicate ledger entries or notifications', async () => {
    const { circle, cycle1 } = await makeActiveCircle();

    // First close
    const r1 = await closeCycle(circle, cycle1);
    expect(r1.skipped).toBeUndefined();

    const ledger1 = await LedgerEntry.countDocuments({ circle: circle._id });
    const notifs1 = await Notification.countDocuments({ circle: circle._id });

    // Second close — cycle is now 'closed', must skip
    const freshCycle = await Cycle.findById(cycle1._id).lean();
    const r2 = await closeCycle(circle, freshCycle);
    expect(r2.skipped).toBe(true);

    const ledger2 = await LedgerEntry.countDocuments({ circle: circle._id });
    const notifs2 = await Notification.countDocuments({ circle: circle._id });

    expect(ledger2).toBe(ledger1);
    expect(notifs2).toBe(notifs1);
  });

  it('runEngine called twice on same circle produces no duplicate entries', async () => {
    const { circle } = await makeActiveCircle();

    await runEngine({ circleId: circle._id });
    const l1 = await LedgerEntry.countDocuments({ circle: circle._id });
    const n1 = await Notification.countDocuments({ circle: circle._id });

    await runEngine({ circleId: circle._id });
    const l2 = await LedgerEntry.countDocuments({ circle: circle._id });
    const n2 = await Notification.countDocuments({ circle: circle._id });

    expect(l2).toBe(l1);
    expect(n2).toBe(n1);
  });
});

// ── 3. Close cycle with missed member ────────────────────────────────────────

describe('Engine: close cycle with missed member', () => {
  it('creates missed entry + payout entry with shortfall, opens cycle 2', async () => {
    const { circle, cycle1, org, mem1, mem2 } = await makeActiveCircle();

    // org and mem1 paid on time; mem2 did NOT pay (stays 'pending' → will be missed)
    await Obligation.updateMany(
      { cycle: cycle1._id, user: { $in: [org._id, mem1._id] } },
      { $set: { status: 'paid_on_time', paidAt: new Date() } }
    );

    await runEngine({ circleId: circle._id });

    // ── Ledger ────────────────────────────────────────────────────────────────
    const entries = await LedgerEntry.find({ circle: circle._id }).sort({ seq: 1 }).lean();
    // 1 missed entry (mem2) + 1 payout entry (org, the cycle 1 recipient)
    expect(entries.length).toBe(2);

    const missedEntry = entries.find((e) => e.type === 'missed');
    const payoutEntry = entries.find((e) => e.type === 'payout');

    expect(missedEntry).toBeDefined();
    expect(String(missedEntry.user)).toBe(String(mem2._id));
    expect(missedEntry.amountKobo).toBe(50_000);
    expect(missedEntry.meta.note).toMatch(/no real money/i);

    expect(payoutEntry).toBeDefined();
    expect(String(payoutEntry.user)).toBe(String(org._id)); // cycle1 recipient
    expect(payoutEntry.amountKobo).toBe(100_000);           // 2 paid × 50,000
    expect(payoutEntry.meta.shortfallKobo).toBe(50_000);    // 1 missed × 50,000
    expect(payoutEntry.meta.note).toMatch(/sandbox/i);

    // ── Cycle status ──────────────────────────────────────────────────────────
    const closedCycle1 = await Cycle.findById(cycle1._id).lean();
    expect(closedCycle1.status).toBe('closed');
    expect(closedCycle1.potKobo).toBe(100_000);

    const openCycle2 = await Cycle.findOne({ circle: circle._id, number: 2 }).lean();
    expect(openCycle2.status).toBe('open');

    const updatedCircle = await Circle.findById(circle._id).lean();
    expect(updatedCircle.currentCycleNumber).toBe(2);

    // ── Cycle 2 obligations ───────────────────────────────────────────────────
    const cycle2Obs = await Obligation.find({ cycle: openCycle2._id }).lean();
    expect(cycle2Obs.length).toBe(3);
    expect(cycle2Obs.every((o) => o.status === 'pending')).toBe(true);

    // ── Obligations status for cycle 1 ────────────────────────────────────────
    const mem2Ob = await Obligation.findOne({ cycle: cycle1._id, user: mem2._id }).lean();
    expect(mem2Ob.status).toBe('missed');

    // ── Notifications ─────────────────────────────────────────────────────────
    const missedNotif = await Notification.findOne({
      kind: 'payment_missed', user: mem2._id, circle: circle._id,
    }).lean();
    expect(missedNotif).not.toBeNull();

    const payoutNotif = await Notification.findOne({
      kind: 'payout_sent', user: org._id, circle: circle._id,
    }).lean();
    expect(payoutNotif).not.toBeNull();

    const cycleOpenNotifs = await Notification.find({
      kind: 'cycle_open', circle: circle._id,
    }).lean();
    expect(cycleOpenNotifs.length).toBe(3); // one per member
  });
});

// ── 4. Reminder dedupe ────────────────────────────────────────────────────────

describe('Reminder dedupe', () => {
  it('running runReminders twice yields only one notification + one email per kind per obligation', async () => {
    // Use futureClosesAt so closesAt hasn't passed (overdue window is open)
    const { circle } = await makeActiveCircle({ futureClosesAt: true });

    // dueDate is 5 days in the past, closesAt is 5 days in the future → 'overdue' for all 3 obligations
    const before = await Notification.countDocuments({ kind: 'reminder', circle: circle._id });

    await runReminders({ circleId: circle._id });
    const after1 = await Notification.countDocuments({ kind: 'reminder', circle: circle._id });
    expect(after1).toBeGreaterThan(before); // reminders fired

    await runReminders({ circleId: circle._id });
    const after2 = await Notification.countDocuments({ kind: 'reminder', circle: circle._id });

    // Second run must NOT create any new notifications (deduped by unique dedupeKey)
    expect(after2).toBe(after1);
  });
});

// ── 5. POST /api/jobs/run — secret guard ──────────────────────────────────────

describe('POST /api/jobs/run', () => {
  async function getApp() {
    const { default: app } = await import('../src/app.js');
    return app;
  }

  it('rejects request with no secret header → 401', async () => {
    const app = await getApp();
    const res = await supertest(app).post('/api/jobs/run');
    expect(res.status).toBe(401);
  });

  it('rejects request with wrong secret → 401', async () => {
    const app = await getApp();
    const res = await supertest(app)
      .post('/api/jobs/run')
      .set('x-cron-secret', 'totally-wrong-secret-value');
    expect(res.status).toBe(401);
  });

  it('accepts request with correct CRON_SECRET → 200 with summary', async () => {
    const app = await getApp();
    const res = await supertest(app)
      .post('/api/jobs/run')
      .set('x-cron-secret', process.env.CRON_SECRET);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('engine');
    expect(res.body.data).toHaveProperty('reminders');
    expect(Array.isArray(res.body.data.engine)).toBe(true);
  });
});
