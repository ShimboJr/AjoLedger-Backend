/**
 * cycleService.js — cycle engine helpers.
 * Full implementation (openNextCycle, closeCycle) arrives on Day 4.
 * Used here: getOpenCycle for the detail endpoint.
 */
import { Cycle } from '../models/Cycle.js';
import { createError } from '../middleware/error.js';

/**
 * getOpenCycle(circleId) — returns the currently open cycle or null.
 */
export async function getOpenCycle(circleId) {
  return Cycle.findOne({ circle: circleId, status: 'open' }).lean();
}

/**
 * getCycleByNumber(circleId, number) — fetch a specific cycle.
 */
export async function getCycleByNumber(circleId, number) {
  const cycle = await Cycle.findOne({ circle: circleId, number }).lean();
  if (!cycle) throw createError(404, 'NOT_FOUND', `Cycle ${number} not found`);
  return cycle;
}
