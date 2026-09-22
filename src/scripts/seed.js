/**
 * seed.js — demo seed script for AjoLedger.
 *
 * Usage:
 *   npm run seed           → seed the database (skips if already seeded)
 *   npm run seed:reset     → wipe app collections then re-seed
 *   npm run seed -- --force → force seed even if data exists
 *
 * Safety: seed:reset refuses to run in NODE_ENV=production unless --force is passed.
 *
 * Demo world:
 *   5 users: Ada (organizer), Emeka, Chidi, Funke, Tunde
 *   Circle 1 "Office Ajo"   — 5 members, ₦20,000/month, 4 cycles
 *     Cycles 1-3 closed with realistic mix (Ada always on time,
 *     Emeka misses once and pays late once, others mostly on time).
 *     Cycle 4 OPEN: Ada + Funke paid, Emeka + Chidi + Tunde pending.
 *     simulatedNow set 1 day before cycle-4 closesAt.
 *   Circle 2 "Savings Club" — 3 members (Ada, Chidi, Funke), ₦10,000/monthly, 3 cycles — COMPLETED.
 *   Ada's trust profile: isPublic=true, slug="ada-demo".
 *
 * Settlement uses applyVerifiedPayment (from services/payments.js) directly —
 * NO Paystack calls.
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

// ── Boot ──────────────────────────────────────────────────────────────────────
// Load env BEFORE importing service modules that call env.js
const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('❌  MONGODB_URI not set. Copy server/.env.example → server/.env and fill in values.');
  process.exit(1);
}

const args        = process.argv.slice(2);
const isReset     = args[0] === 'reset';
const isForce     = args.includes('--force');
const NODE_ENV    = process.env.NODE_ENV ?? 'development';
const DEMO_PW     = process.env.SEED_PASSWORD ?? 'AjoDemo2026!';

// Refuse destructive reset in production without --force
if (isReset && NODE_ENV === 'production' && !isForce) {
  console.error('❌  seed:reset refused in production. Pass --force to override.');
  process.exit(1);
}

// ── Model imports (after dotenv) ──────────────────────────────────────────────
import { User }        from '../models/User.js';
import { Circle }      from '../models/Circle.js';
import { Membership }  from '../models/Membership.js';
import { Cycle }       from '../models/Cycle.js';
import { Obligation }  from '../models/Obligation.js';
import { Payment }     from '../models/Payment.js';
import { LedgerEntry } from '../models/LedgerEntry.js';
import { Notification }from '../models/Notification.js';
import { addDays, addPeriods } from '../utils/dates.js';
import { generateInviteCode }  from '../utils/ids.js';
import { applyVerifiedPayment } from '../services/payments.js';
import { runEngine }            from '../services/engine.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const COLLECTIONS = [
  'users', 'circles', 'memberships', 'cycles',
  'obligations', 'payments', 'ledgerentries', 'notifications',
];

async function wipeCollections() {
  for (const name of COLLECTIONS) {
    const col = mongoose.connection.collection(name);
    await col.deleteMany({}).catch(() => {}); // Ignore if collection doesn't exist yet
  }
  console.log('🗑️   Wiped app collections.');
}

/**
 * seedPayment — record a contribution for one obligation + append ledger entry.
 * Creates a minimal dummy Payment record then calls applyVerifiedPayment.
 *
 * @param {object} params
 * @param {number} seedIndex - unique index used in sandbox reference
 */
async function seedPayment({ obligation, cycle, circle, reference }) {
  const MAX_RETRIES = 3;

  // Create the dummy Payment record (sandbox, no Paystack)
  await Payment.create({
    reference,
    circle:     obligation.circle,
    cycle:      obligation.cycle,
    obligation: obligation._id,
    user:       obligation.user,
    amountKobo: obligation.amountKobo,
    status:     'initialized',
  });

  // Apply inside a transaction
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const payment = await Payment.findOne({ reference }).session(session).lean();
        const freshOb = await Obligation.findById(obligation._id).session(session);
        const freshCy = await Cycle.findById(cycle._id).session(session).lean();
        const freshCi = await Circle.findById(circle._id).session(session).lean();

        await applyVerifiedPayment(session, {
          payment:     payment,
          obligation:  freshOb,
          cycle:       freshCy,
          circle:      freshCi,
          reference,
          gatewayMeta: { channel: 'seed', gateway_response: 'Sandbox' },
        });
      });
      break;
    } catch (err) {
      if (err.code === 11000 && attempt < MAX_RETRIES - 1) continue;
      throw err;
    } finally {
      await session.endSession();
    }
  }
}

/**
 * createCircleWithMembers — helper: create circle, add members, start it.
 */
async function createCircleWithMembers({ name, organizer, members, contributionKobo, frequency, graceDays, startDate }) {
  // Generate unique invite code
  let inviteCode;
  for (let i = 0; i < 10; i++) {
    const c = generateInviteCode();
    const exists = await Circle.findOne({ inviteCode: c }).lean();
    if (!exists) { inviteCode = c; break; }
  }

  const circle = await Circle.create({
    name,
    organizer: organizer._id,
    contributionKobo,
    frequency,
    maxMembers: members.length + 1, // +1 slack
    startDate,
    graceDays,
    status: 'forming',
    inviteCode,
    currentCycleNumber: 0,
    totalCycles: 0,
  });

  // Create memberships (organizer = position 1, then rest in order)
  const allMembers = [organizer, ...members];
  await Membership.insertMany(
    allMembers.map((u, idx) => ({
      circle:  circle._id,
      user:    u._id,
      position: idx + 1,
      role:    idx === 0 ? 'organizer' : 'member',
      joinedAt: new Date(),
    }))
  );

  // ── Start circle (replicates startCircle without auth checks) ────────────────
  const n = allMembers.length;

  const cycleDocs = allMembers.map((m, idx) => {
    const dueDate  = addPeriods(startDate, frequency, idx);
    const closesAt = addDays(dueDate, graceDays);
    return {
      circle:    circle._id,
      number:    idx + 1,
      dueDate,
      closesAt,
      recipient: m._id,
      status:    idx === 0 ? 'open' : 'scheduled',
      potKobo:   0,
    };
  });

  const createdCycles = await Cycle.insertMany(cycleDocs);

  await Circle.updateOne(
    { _id: circle._id },
    { $set: { status: 'active', totalCycles: n, currentCycleNumber: 1 } }
  );

  const cycle1 = createdCycles.find((c) => c.number === 1);
  await Obligation.insertMany(
    allMembers.map((u) => ({
      circle:      circle._id,
      cycle:       cycle1._id,
      cycleNumber: 1,
      user:        u._id,
      amountKobo:  contributionKobo,
      status:      'pending',
    }))
  );

  const fresh = await Circle.findById(circle._id).lean();
  return { circle: fresh, cycles: createdCycles };
}

/**
 * closeCycleWithEngine — set simulatedNow past closesAt and run engine.
 * Reloads circle afterwards.
 */
async function closeCycleWithEngine(circleId, closesAt) {
  // Set simulatedNow to 1 minute after closesAt
  const past = new Date(closesAt.getTime() + 60 * 1000);
  await Circle.updateOne({ _id: circleId }, { $set: { simulatedNow: past } });
  await runEngine({ circleId });
  // Clear simulatedNow
  await Circle.updateOne({ _id: circleId }, { $set: { simulatedNow: null } });
  return Circle.findById(circleId).lean();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🌱  AjoLedger seed script starting…\n');
  await mongoose.connect(MONGO_URI);
  console.log('✅  Connected to MongoDB');

  if (isReset) {
    await wipeCollections();
  } else {
    // Skip if already seeded (idempotency guard)
    const existing = await User.findOne({ email: 'ada@demo.ajoledger.example.com' }).lean();
    if (existing && !isForce) {
      console.log('ℹ️   Seed data already present. Run with "reset" to re-seed.\n');
      await mongoose.disconnect();
      return;
    }
  }

  const passwordHash = await bcrypt.hash(DEMO_PW, 10);

  // ── 1. Create users ──────────────────────────────────────────────────────────
  console.log('👥  Creating 5 demo users…');

  const [ada, emeka, chidi, funke, tunde] = await User.insertMany([
    {
      name: 'Ada Okafor',
      email: 'ada@demo.ajoledger.example.com',
      passwordHash,
      trust: { slug: 'ada-demo', isPublic: true },
    },
    {
      name: 'Emeka Nwosu',
      email: 'emeka@demo.ajoledger.example.com',
      passwordHash,
      trust: { isPublic: false },
    },
    {
      name: 'Chidi Eze',
      email: 'chidi@demo.ajoledger.example.com',
      passwordHash,
      trust: { isPublic: false },
    },
    {
      name: 'Funke Adeyemi',
      email: 'funke@demo.ajoledger.example.com',
      passwordHash,
      trust: { isPublic: false },
    },
    {
      name: 'Tunde Bello',
      email: 'tunde@demo.ajoledger.example.com',
      passwordHash,
      trust: { isPublic: false },
    },
  ]);

  console.log('   ✓ Ada, Emeka, Chidi, Funke, Tunde created');

  // ── 2. Circle 2 first: "Savings Club" (3 members, 3 cycles, COMPLETED) ──────
  // Done first so all 3 users have 3+ resolved obligations for scoring.

  console.log('\n🔵  Creating "Savings Club" (3 members, ₦10,000/month, 3 cycles)…');

  // Start date 4 months ago so all cycles are naturally past
  const clubStart = new Date();
  clubStart.setMonth(clubStart.getMonth() - 4);
  clubStart.setDate(1);

  const { circle: club, cycles: clubCycles } = await createCircleWithMembers({
    name:             'Savings Club',
    organizer:        ada,
    members:          [chidi, funke],
    contributionKobo: 1_000_000, // ₦10,000
    frequency:        'monthly',
    graceDays:        2,
    startDate:        clubStart,
  });

  // Cycle 1: all 3 paid on time
  const clubCy1    = clubCycles.find((c) => c.number === 1);
  const clubCy1obs = await Obligation.find({ cycle: clubCy1._id }).lean();

  let seedIdx = 1;
  for (const ob of clubCy1obs) {
    await seedPayment({
      obligation: ob,
      cycle:      clubCy1,
      circle:     club,
      reference:  `SEED-${seedIdx++}`,
    });
  }
  await closeCycleWithEngine(club._id, clubCy1.closesAt);
  console.log('   ✓ Savings Club cycle 1 closed (3/3 paid)');

  // Cycle 2: all paid
  const clubFresh2 = await Circle.findById(club._id).lean();
  const clubCy2    = await Cycle.findOne({ circle: club._id, status: 'open' }).lean();
  const clubCy2obs = await Obligation.find({ cycle: clubCy2._id }).lean();
  for (const ob of clubCy2obs) {
    await seedPayment({ obligation: ob, cycle: clubCy2, circle: clubFresh2, reference: `SEED-${seedIdx++}` });
  }
  await closeCycleWithEngine(club._id, clubCy2.closesAt);
  console.log('   ✓ Savings Club cycle 2 closed (3/3 paid)');

  // Cycle 3: all paid → circle completes
  const clubFresh3 = await Circle.findById(club._id).lean();
  const clubCy3    = await Cycle.findOne({ circle: club._id, status: 'open' }).lean();
  const clubCy3obs = await Obligation.find({ cycle: clubCy3._id }).lean();
  for (const ob of clubCy3obs) {
    await seedPayment({ obligation: ob, cycle: clubCy3, circle: clubFresh3, reference: `SEED-${seedIdx++}` });
  }
  await closeCycleWithEngine(club._id, clubCy3.closesAt);
  console.log('   ✓ Savings Club cycle 3 closed → circle COMPLETED ✅');

  // ── 3. Circle 1: "Office Ajo" (5 members, ₦20,000, 4 cycles) ────────────────
  console.log('\n🟢  Creating "Office Ajo" (5 members, ₦20,000/month, 4 cycles)…');

  // Start date 4 months ago
  const officeStart = new Date();
  officeStart.setMonth(officeStart.getMonth() - 4);
  officeStart.setDate(1);

  const { circle: office, cycles: officeCycles } = await createCircleWithMembers({
    name:             'Office Ajo',
    organizer:        ada,
    members:          [emeka, chidi, funke, tunde],
    contributionKobo: 2_000_000, // ₦20,000
    frequency:        'monthly',
    graceDays:        2,
    startDate:        officeStart,
  });

  // ── Cycle 1: all 5 paid on time ─────────────────────────────────────────────
  const offCy1    = officeCycles.find((c) => c.number === 1);
  const offCy1obs = await Obligation.find({ cycle: offCy1._id }).lean();
  for (const ob of offCy1obs) {
    await seedPayment({ obligation: ob, cycle: offCy1, circle: office, reference: `SEED-${seedIdx++}` });
  }
  await closeCycleWithEngine(office._id, offCy1.closesAt);
  console.log('   ✓ Office Ajo cycle 1 closed (5/5 paid)');

  // ── Cycle 2: Emeka MISSES; Ada, Chidi, Funke, Tunde pay on time ─────────────
  const officeFresh2 = await Circle.findById(office._id).lean();
  const offCy2       = await Cycle.findOne({ circle: office._id, status: 'open' }).lean();
  const offCy2obs    = await Obligation.find({ cycle: offCy2._id }).lean();

  // Pay everyone except Emeka
  for (const ob of offCy2obs) {
    if (String(ob.user) === String(emeka._id)) continue; // Emeka misses
    await seedPayment({ obligation: ob, cycle: offCy2, circle: officeFresh2, reference: `SEED-${seedIdx++}` });
  }
  // Run engine (Emeka's obligation → missed)
  await closeCycleWithEngine(office._id, offCy2.closesAt);
  console.log('   ✓ Office Ajo cycle 2 closed (4/5 paid, Emeka missed)');

  // ── Cycle 3: Emeka pays LATE (after dueDate, before closesAt); others on time ─
  const officeFresh3 = await Circle.findById(office._id).lean();
  const offCy3       = await Cycle.findOne({ circle: office._id, status: 'open' }).lean();
  const offCy3obs    = await Obligation.find({ cycle: offCy3._id }).lean();

  // Pay Ada, Chidi, Funke, Tunde on time (set simulatedNow before dueDate)
  await Circle.updateOne({ _id: office._id }, { $set: { simulatedNow: new Date(offCy3.dueDate.getTime() - 60 * 60 * 1000) } });
  const officeFresh3a = await Circle.findById(office._id).lean();
  for (const ob of offCy3obs) {
    if (String(ob.user) === String(emeka._id)) continue;
    await seedPayment({ obligation: ob, cycle: offCy3, circle: officeFresh3a, reference: `SEED-${seedIdx++}` });
  }

  // Pay Emeka late (after dueDate, before closesAt)
  await Circle.updateOne({ _id: office._id }, { $set: { simulatedNow: new Date(offCy3.closesAt.getTime() - 30 * 60 * 1000) } });
  const officeFresh3b = await Circle.findById(office._id).lean();
  const emekaOb3 = offCy3obs.find((o) => String(o.user) === String(emeka._id));
  await seedPayment({ obligation: emekaOb3, cycle: offCy3, circle: officeFresh3b, reference: `SEED-${seedIdx++}` });

  // Clear simulated time and close
  await Circle.updateOne({ _id: office._id }, { $set: { simulatedNow: null } });
  await closeCycleWithEngine(office._id, offCy3.closesAt);
  console.log('   ✓ Office Ajo cycle 3 closed (5/5 paid; Emeka paid late)');

  // ── Cycle 4: OPEN — Ada + Funke paid, 3 pending. simulatedNow = 1 day before closesAt ─
  const officeFresh4 = await Circle.findById(office._id).lean();
  const offCy4       = await Cycle.findOne({ circle: office._id, status: 'open' }).lean();
  const offCy4obs    = await Obligation.find({ cycle: offCy4._id }).lean();

  // Ada and Funke pay on time
  const payers4 = [ada, funke].map((u) => u._id.toString());
  for (const ob of offCy4obs) {
    if (!payers4.includes(ob.user.toString())) continue;
    await seedPayment({ obligation: ob, cycle: offCy4, circle: officeFresh4, reference: `SEED-${seedIdx++}` });
  }

  // Leave Emeka, Chidi, Tunde pending — set simulatedNow to 1 day before closesAt
  const oneDayBefore = new Date(offCy4.closesAt.getTime() - 24 * 60 * 60 * 1000);
  await Circle.updateOne({ _id: office._id }, { $set: { simulatedNow: oneDayBefore } });
  console.log('   ✓ Office Ajo cycle 4 OPEN (Ada ✓, Funke ✓, Emeka/Chidi/Tunde pending)');
  console.log(`   ℹ️   simulatedNow set to 1 day before cycle 4 closes (${oneDayBefore.toISOString()})`);

  // ── 4. Ada's trust profile ────────────────────────────────────────────────────
  // Slug + isPublic already set during user creation; verify it was saved.
  const adaFresh = await User.findById(ada._id).select('trust').lean();
  console.log(`\n🔖  Ada's public trust URL: ${process.env.CLIENT_URL}/t/${adaFresh.trust?.slug}`);

  // ── 5. Print cheat sheet ──────────────────────────────────────────────────────
  const officeDoc = await Circle.findById(office._id).lean();
  const clientUrl = process.env.CLIENT_URL ?? 'http://localhost:5173';

  console.log(`
╔═══════════════════════════════════════════════════════════╗
║              AjoLedger — Demo Cheat Sheet                 ║
╠═══════════════════════════════════════════════════════════╣
║  Shared password: ${DEMO_PW.padEnd(42)}║
╠═══════════════════════════════════════════════════════════╣
║  Users (email → role)                                     ║
║    ada@demo.ajoledger.example.com     (organizer)         ║
║    emeka@demo.ajoledger.example.com   (member)            ║
║    chidi@demo.ajoledger.example.com   (member)            ║
║    funke@demo.ajoledger.example.com   (member)            ║
║    tunde@demo.ajoledger.example.com   (member)            ║
╠═══════════════════════════════════════════════════════════╣
║  Circles                                                  ║
║    Office Ajo  → ${(clientUrl + '/circles/' + officeDoc._id).slice(0, 45).padEnd(45)}║
║    Savings Club → completed ✅                            ║
╠═══════════════════════════════════════════════════════════╣
║  Public Trust Profile (Ada)                               ║
║    ${(clientUrl + '/t/ada-demo').padEnd(57)}║
╚═══════════════════════════════════════════════════════════╝
  `);

  await mongoose.disconnect();
  console.log('✅  Seed complete.\n');
}

main().catch((err) => {
  console.error('❌  Seed failed:', err);
  mongoose.disconnect().finally(() => process.exit(1));
});
