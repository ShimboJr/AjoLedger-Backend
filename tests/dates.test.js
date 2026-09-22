import { describe, it, expect } from 'vitest';
import { addPeriod, addPeriods, addDays, addMonths } from '../src/utils/dates.js';

// Helper to create UTC-midnight dates cleanly
function utc(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d));
}

describe('addDays', () => {
  it('adds 7 days correctly', () => {
    const result = addDays(utc(2025, 1, 15), 7);
    expect(result.toISOString().slice(0, 10)).toBe('2025-01-22');
  });

  it('crosses month boundary', () => {
    const result = addDays(utc(2025, 1, 29), 3);
    expect(result.toISOString().slice(0, 10)).toBe('2025-02-01');
  });
});

describe('addMonths', () => {
  it('adds one month normally', () => {
    expect(addMonths(utc(2025, 3, 15), 1).toISOString().slice(0, 10)).toBe('2025-04-15');
  });

  it('clamps Jan 31 + 1 month to Feb 28 (non-leap 2025)', () => {
    expect(addMonths(utc(2025, 1, 31), 1).toISOString().slice(0, 10)).toBe('2025-02-28');
  });

  it('clamps Jan 31 + 1 month to Feb 29 (leap year 2024)', () => {
    expect(addMonths(utc(2024, 1, 31), 1).toISOString().slice(0, 10)).toBe('2024-02-29');
  });

  it('Jan 31 + 3 months → Apr 30 (April has 30 days)', () => {
    expect(addMonths(utc(2025, 1, 31), 3).toISOString().slice(0, 10)).toBe('2025-04-30');
  });

  it('Jan 31 + 2 months → Mar 31 (March has 31 days)', () => {
    expect(addMonths(utc(2025, 1, 31), 2).toISOString().slice(0, 10)).toBe('2025-03-31');
  });

  it('Dec 31 + 1 month → Jan 31 next year', () => {
    expect(addMonths(utc(2025, 12, 31), 1).toISOString().slice(0, 10)).toBe('2026-01-31');
  });
});

describe('addPeriod', () => {
  it('weekly: adds 7 days', () => {
    expect(addPeriod(utc(2025, 1, 15), 'weekly').toISOString().slice(0, 10)).toBe('2025-01-22');
  });

  it('biweekly: adds 14 days', () => {
    expect(addPeriod(utc(2025, 1, 15), 'biweekly').toISOString().slice(0, 10)).toBe('2025-01-29');
  });

  it('monthly: Jan 31 → Feb 28 (non-leap)', () => {
    expect(addPeriod(utc(2025, 1, 31), 'monthly').toISOString().slice(0, 10)).toBe('2025-02-28');
  });

  it('monthly: Jan 31 → Feb 29 (leap year)', () => {
    expect(addPeriod(utc(2024, 1, 31), 'monthly').toISOString().slice(0, 10)).toBe('2024-02-29');
  });

  it('throws on unknown frequency', () => {
    expect(() => addPeriod(utc(2025, 1, 1), 'quarterly')).toThrow('Unknown frequency');
  });
});

describe('addPeriods (from base date — no drift)', () => {
  it('n=0 returns a copy of the original date', () => {
    const d = utc(2025, 1, 31);
    const result = addPeriods(d, 'monthly', 0);
    expect(result.toISOString().slice(0, 10)).toBe('2025-01-31');
    expect(result).not.toBe(d); // must be a new object
  });

  it('monthly n=1: Jan 31 → Feb 28', () => {
    expect(addPeriods(utc(2025, 1, 31), 'monthly', 1).toISOString().slice(0, 10)).toBe('2025-02-28');
  });

  it('monthly n=2: Jan 31 → Mar 31 (not Feb 28 + 1 month = Mar 28)', () => {
    expect(addPeriods(utc(2025, 1, 31), 'monthly', 2).toISOString().slice(0, 10)).toBe('2025-03-31');
  });

  it('monthly n=3: Jan 31 → Apr 30', () => {
    expect(addPeriods(utc(2025, 1, 31), 'monthly', 3).toISOString().slice(0, 10)).toBe('2025-04-30');
  });

  it('monthly n=12: Jan 15 → Jan 15 next year', () => {
    expect(addPeriods(utc(2025, 1, 15), 'monthly', 12).toISOString().slice(0, 10)).toBe('2026-01-15');
  });

  it('weekly n=4: Jan 1 → Jan 29', () => {
    expect(addPeriods(utc(2025, 1, 1), 'weekly', 4).toISOString().slice(0, 10)).toBe('2025-01-29');
  });

  it('biweekly n=3: Jan 1 → Feb 12', () => {
    expect(addPeriods(utc(2025, 1, 1), 'biweekly', 3).toISOString().slice(0, 10)).toBe('2025-02-12');
  });

  it('leap year: Feb 29 2024 + monthly n=1 → Mar 29', () => {
    expect(addPeriods(utc(2024, 2, 29), 'monthly', 1).toISOString().slice(0, 10)).toBe('2024-03-29');
  });

  it('leap year: Feb 29 2024 + monthly n=12 → Feb 28 2025 (non-leap)', () => {
    expect(addPeriods(utc(2024, 2, 29), 'monthly', 12).toISOString().slice(0, 10)).toBe('2025-02-28');
  });
});
