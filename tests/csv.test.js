/**
 * csv.test.js — unit tests for services/csv.js
 *
 * Tests: csvCell escaping, formula injection guard, column presence,
 * BOM, empty circle, newlines in values, special characters.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { csvCell, buildLedgerCsv } from '../src/services/csv.js';

// ── csvCell unit tests ────────────────────────────────────────────────────────

describe('csvCell', () => {
  it('wraps plain text in double-quotes', () => {
    expect(csvCell('hello')).toBe('"hello"');
  });

  it('doubles internal double-quotes', () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('handles commas without extra escaping (quotes are enough)', () => {
    expect(csvCell('a,b,c')).toBe('"a,b,c"');
  });

  it('handles newlines (CRLF and LF) inside a cell', () => {
    expect(csvCell('line1\r\nline2')).toBe('"line1\r\nline2"');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('converts numbers to strings', () => {
    expect(csvCell(42)).toBe('"42"');
    expect(csvCell(3.14)).toBe('"3.14"');
  });

  it('renders null/undefined as empty string', () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
  });

  it('handles boolean values', () => {
    expect(csvCell(true)).toBe('"true"');
    expect(csvCell(false)).toBe('"false"');
  });
});

// ── Formula injection protection ──────────────────────────────────────────────

describe('csvCell — formula injection guard', () => {
  const TRIGGERS = ['=SUM(1)', '+1', '-1', '@SUM', '\tSYSTEM', '\rSYSTEM'];

  for (const trigger of TRIGGERS) {
    it(`prefixes "${trigger.slice(0, 6)}" with single quote`, () => {
      const cell = csvCell(trigger);
      // Cell should start with "' (quote-wrapped, single-quote prefix)
      expect(cell.startsWith(`"'`)).toBe(true);
    });
  }

  it('does NOT prefix normal text', () => {
    expect(csvCell('normal text')).not.toContain("'");
  });

  it('does NOT prefix text that contains trigger chars in the middle', () => {
    const cell = csvCell('price=100');
    expect(cell.startsWith(`"'`)).toBe(false);
    expect(cell).toBe('"price=100"');
  });
});

// ── buildLedgerCsv integration test ──────────────────────────────────────────

let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  // Register all models needed
  await import('../src/models/LedgerEntry.js');
  await import('../src/models/User.js');
  await import('../src/models/Circle.js');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('buildLedgerCsv', () => {
  it('returns BOM + header row for an empty circle', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const csv = await buildLedgerCsv(fakeId);

    // Must start with UTF-8 BOM
    expect(csv.charCodeAt(0)).toBe(0xFEFF);

    // Header row must contain all expected columns
    const firstLine = csv.split('\r\n')[0];
    expect(firstLine).toContain('"seq"');
    expect(firstLine).toContain('"timestamp_iso"');
    expect(firstLine).toContain('"cycle"');
    expect(firstLine).toContain('"type"');
    expect(firstLine).toContain('"member"');
    expect(firstLine).toContain('"amount_ngn"');
    expect(firstLine).toContain('"reference"');
    expect(firstLine).toContain('"sandbox"');
    expect(firstLine).toContain('"prev_hash"');
    expect(firstLine).toContain('"hash"');
  });

  it('uses CRLF line endings', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const csv = await buildLedgerCsv(fakeId);
    expect(csv).toContain('\r\n');
  });

  it('produces one data row per ledger entry', async () => {
    const { LedgerEntry } = await import('../src/models/LedgerEntry.js');
    const { User }        = await import('../src/models/User.js');
    const { Circle }      = await import('../src/models/Circle.js');

    // Use unique email per test run to avoid duplicate conflicts
    const runId = Date.now();

    const circle = await Circle.create({
      name: `Test CSV Circle ${runId}`,
      organizer: new mongoose.Types.ObjectId(),
      contributionKobo: 100000,
      frequency: 'monthly',
      maxMembers: 2,
      startDate: new Date(),
      inviteCode: `csv${runId}`,
    });

    const user = await User.create({
      name: 'Test User',
      email: `csvtest${runId}@example.com`,
      passwordHash: '$2a$10$placeholder',
    });

    // Insert two ledger entries (LedgerEntry is append-only — inserts only)
    await LedgerEntry.create({
      circle:      circle._id,
      cycle:       new mongoose.Types.ObjectId(),
      cycleNumber: 1,
      seq:         1,
      type:        'contribution',
      user:        user._id,
      amountKobo:  100000,
      prevHash:    'GENESIS',
      hash:        `abc${runId}`,
      sandbox:     true,
    });
    await LedgerEntry.create({
      circle:      circle._id,
      cycle:       new mongoose.Types.ObjectId(),
      cycleNumber: 1,
      seq:         2,
      type:        'payout',
      user:        user._id,
      amountKobo:  100000,
      prevHash:    `abc${runId}`,
      hash:        `def${runId}`,
      sandbox:     true,
    });

    const csv = await buildLedgerCsv(circle._id);
    const lines = csv.split('\r\n').filter(Boolean);

    // 1 header + 2 data rows
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"1"');              // seq
    expect(lines[1]).toContain('"contribution"');
    expect(lines[2]).toContain('"2"');              // seq
    expect(lines[2]).toContain('"payout"');
    expect(lines[1]).toContain('"Test User"');      // member name populated
    // Amount should be in NGN (kobo/100)
    expect(lines[1]).toContain('"1000.00"');
  });
});
