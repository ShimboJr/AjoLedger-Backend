/**
 * tests/ledger.test.js
 *
 * Tests for:
 * (a) appendLedgerEntry + verifyChain — normal operation
 * (b) tamper detection
 * (c) concurrent appends produce a gap-free sequence
 *
 * Requires MongoMemoryReplSet (transactions).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { nanoid } from 'nanoid';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

let replSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { maxPoolSize: 10, serverSelectionTimeoutMS: 10000 });
  await import('../src/models/User.js');
  await import('../src/models/Circle.js');
  await import('../src/models/Membership.js');
  await import('../src/models/Cycle.js');
  await import('../src/models/Obligation.js');
  await import('../src/models/Payment.js');
  await import('../src/models/LedgerEntry.js');
  await import('../src/models/Notification.js');
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet.stop();
}, 30_000);

afterEach(async () => {
  for (const col of Object.values(mongoose.connection.collections)) {
    await col.deleteMany({});
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const { LedgerEntry } = await import('../src/models/LedgerEntry.js');
const { appendLedgerEntry } = await import('../src/services/ledger.js');
const { verifyChain }       = await import('../src/services/ledger.js');

// Build a minimal entry data object with dummy ObjectIds.
// Each call generates a unique reference to avoid the sparse-unique index collision.
function makeEntryData(circleId, overrides = {}) {
  const userId  = new mongoose.Types.ObjectId();
  const cycleId = new mongoose.Types.ObjectId();
  return {
    circle:      circleId,
    cycle:       cycleId,
    cycleNumber: 1,
    type:        'contribution',
    user:        userId,
    amountKobo:  50_000,
    reference:   `TST_${nanoid(12)}`,   // unique per call — avoids reference_1 dup key
    ...overrides,
  };
}

/**
 * Append one entry within its own transaction session.
 * Retries up to 5 times on duplicate-seq (code 11000) to handle concurrent races.
 */
async function appendOne(circleId, overrides = {}) {
  const MAX = 5;
  for (let attempt = 0; attempt < MAX; attempt++) {
    const session = await mongoose.startSession();
    try {
      let entry;
      await session.withTransaction(async () => {
        entry = await appendLedgerEntry(session, makeEntryData(circleId, overrides));
      });
      return entry;
    } catch (err) {
      if (err.code === 11000 && attempt < MAX - 1) continue;
      throw err;
    } finally {
      await session.endSession();
    }
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('appendLedgerEntry + verifyChain', () => {
  it('appends 5 entries and verifyChain returns ok:true, checked:5', async () => {
    const circleId = new mongoose.Types.ObjectId();

    for (let i = 0; i < 5; i++) {
      await appendOne(circleId, { amountKobo: 10_000 * (i + 1) });
    }

    const result = await verifyChain(circleId);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(5);
  });

  it('verified chain links prevHash correctly (GENESIS → hash1 → hash2)', async () => {
    const circleId = new mongoose.Types.ObjectId();
    await appendOne(circleId);
    await appendOne(circleId);

    const entries = await LedgerEntry.find({ circle: circleId }).sort({ seq: 1 }).lean();
    expect(entries[0].prevHash).toBe('GENESIS');
    expect(entries[1].prevHash).toBe(entries[0].hash);
  });

  it('verifyChain returns ok:true, checked:0 for a circle with no entries', async () => {
    const circleId = new mongoose.Types.ObjectId();
    const result = await verifyChain(circleId);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(0);
  });
});

describe('verifyChain tamper detection', () => {
  it('detects a tampered amountKobo at seq 2', async () => {
    const circleId = new mongoose.Types.ObjectId();

    for (let i = 0; i < 3; i++) {
      await appendOne(circleId, { amountKobo: 10_000 });
    }

    // Directly tamper entry at seq 2 by bypassing the append-only guard
    // (we use replaceOne which the schema hook doesn't block — only updateOne/findOneAndUpdate etc.)
    // Actually the schema blocks replaceOne too — use native driver instead.
    const nativeCollection = mongoose.connection.collection('ledgerentries');
    await nativeCollection.updateOne(
      { circle: circleId, seq: 2 },
      { $set: { amountKobo: 999_999 } }
    );

    const result = await verifyChain(circleId);
    expect(result.ok).toBe(false);
    expect(result.brokenAtSeq).toBe(2);
    expect(result.reason).toMatch(/hash mismatch/i);
  });

  it('detects a gap (seq 1, 3 — missing seq 2)', async () => {
    const circleId = new mongoose.Types.ObjectId();
    const nativeCollection = mongoose.connection.collection('ledgerentries');

    // Insert two entries then delete seq 2 directly
    await appendOne(circleId);
    await appendOne(circleId);
    await appendOne(circleId);

    await nativeCollection.deleteOne({ circle: circleId, seq: 2 });

    const result = await verifyChain(circleId);
    expect(result.ok).toBe(false);
    expect(result.brokenAtSeq).toBe(3); // seq 3 found where seq 2 was expected
    expect(result.reason).toMatch(/gap/i);
  });
});

describe('concurrent appendLedgerEntry', () => {
  it('5 concurrent appends produce a gap-free, unique sequence 1-5', async () => {
    const circleId = new mongoose.Types.ObjectId();

    // All 5 start at the same time — race on seq; each retries on 11000
    await Promise.all(Array.from({ length: 5 }, (_, i) =>
      appendOne(circleId, { amountKobo: (i + 1) * 1000 })
    ));

    const entries = await LedgerEntry.find({ circle: circleId }).sort({ seq: 1 }).lean();
    expect(entries).toHaveLength(5);
    entries.forEach((e, i) => expect(e.seq).toBe(i + 1));

    // Chain must also be valid
    const verification = await verifyChain(circleId);
    expect(verification.ok).toBe(true);
    expect(verification.checked).toBe(5);
  });
});
