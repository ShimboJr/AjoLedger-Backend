/**
 * csv.js — ledger CSV export.
 *
 * buildLedgerCsv(circleId) — fetches all ledger entries (sorted by seq ascending),
 * builds a UTF-8 BOM + RFC-4180 CSV string.
 *
 * Columns: seq, timestamp_iso, cycle, type, member, amount_ngn, reference,
 *          sandbox, prev_hash, hash
 *
 * Security:
 *   - All cells are quoted (RFC-4180 — quotes inside values are doubled).
 *   - Formula-injection: cells whose content starts with = + - @ TAB CR
 *     are prefixed with a single quote (') before quoting.
 *   - UTF-8 BOM prepended so Excel renders Unicode names correctly.
 */

import { LedgerEntry } from '../models/LedgerEntry.js';

// Columns in output order
const HEADERS = [
  'seq',
  'timestamp_iso',
  'cycle',
  'type',
  'member',
  'amount_ngn',
  'reference',
  'sandbox',
  'prev_hash',
  'hash',
];

// Characters that trigger formula injection in spreadsheets
const INJECTION_CHARS = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * csvCell(value) — escape a single cell value for RFC-4180.
 * Always wraps in double-quotes; doubles any internal quotes.
 * Prepends ' to cells starting with injection trigger characters.
 *
 * @param {string|number|boolean|null|undefined} value
 * @returns {string}
 */
export function csvCell(value) {
  const raw = value == null ? '' : String(value);

  // Formula-injection guard
  const safe = raw.length > 0 && INJECTION_CHARS.has(raw[0]) ? `'${raw}` : raw;

  // RFC-4180: wrap in double-quotes, escape internal double-quotes by doubling
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * buildCsvRow(cells) — join an array of already-escaped cells.
 * @param {string[]} cells
 * @returns {string}
 */
function buildCsvRow(cells) {
  return cells.join(',');
}

/**
 * buildLedgerCsv(circleId) — build full CSV string for a circle's ledger.
 *
 * @param {string|import('mongoose').Types.ObjectId} circleId
 * @returns {Promise<string>} CSV string with UTF-8 BOM
 */
export async function buildLedgerCsv(circleId) {
  const entries = await LedgerEntry.find({ circle: circleId })
    .sort({ seq: 1 })
    .populate('user', 'name')
    .lean();

  const rows = [
    // Header row
    buildCsvRow(HEADERS.map(csvCell)),
    // Data rows
    ...entries.map((e) =>
      buildCsvRow([
        csvCell(e.seq),
        csvCell(new Date(e.createdAt).toISOString()),
        csvCell(e.cycleNumber),
        csvCell(e.type),
        csvCell(e.user?.name ?? ''),
        csvCell((e.amountKobo / 100).toFixed(2)),
        csvCell(e.reference ?? ''),
        csvCell(e.sandbox ? 'true' : 'false'),
        csvCell(e.prevHash),
        csvCell(e.hash),
      ])
    ),
  ];

  // UTF-8 BOM + CRLF line endings (Excel compatibility)
  return '\uFEFF' + rows.join('\r\n') + '\r\n';
}

/**
 * circleNameToSlug(name) — safe filename slug from circle name.
 * @param {string} name
 * @returns {string}
 */
export function circleNameToSlug(name) {
  return (name ?? 'circle')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
