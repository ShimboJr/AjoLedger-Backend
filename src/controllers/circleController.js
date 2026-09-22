import { z } from 'zod';
import {
  createCircle,
  listMyCircles,
  previewCircle,
  joinByCode,
  getCircleDetail,
  updatePayoutOrder,
  startCircle,
} from '../services/circleService.js';
import { env } from '../config/env.js';

// ── Zod schemas ──────────────────────────────────────────────────────────────

export const createCircleSchema = z.object({
  name: z.string().trim().min(3, 'Name must be at least 3 characters').max(60, 'Name must be at most 60 characters'),
  // Client sends kobo (integer). 100 naira = 10,000 kobo; 1,000,000 naira = 100,000,000 kobo
  contributionKobo: z
    .number({ invalid_type_error: 'Contribution must be a number' })
    .int('Contribution must be a whole number in kobo')
    .min(10_000, 'Minimum contribution is ₦100')
    .max(100_000_000, 'Maximum contribution is ₦1,000,000'),
  frequency: z.enum(['weekly', 'biweekly', 'monthly'], {
    errorMap: () => ({ message: 'Frequency must be weekly, biweekly, or monthly' }),
  }),
  maxMembers: z
    .number({ invalid_type_error: 'Max members must be a number' })
    .int()
    .min(2, 'Minimum 2 members')
    .max(12, 'Maximum 12 members'),
  startDate: z
    .string({ required_error: 'Start date is required' })
    .refine((s) => !isNaN(new Date(s).getTime()), { message: 'Invalid date' })
    .transform((s) => new Date(s))
    .refine(
      (d) => {
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        return d >= today;
      },
      { message: 'Start date must be today or in the future' }
    ),
  graceDays: z.number().int().min(0).max(5).default(2),
});

export const payoutOrderSchema = z.object({
  order: z
    .array(z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid user ID'))
    .min(2, 'Order must have at least 2 members'),
});

// ── Controller functions ─────────────────────────────────────────────────────

export async function handleCreateCircle(req, res, next) {
  try {
    const { circle, inviteUrl } = await createCircle(req.user._id, req.body);
    return res.status(201).json({ data: { circle, inviteUrl } });
  } catch (err) { next(err); }
}

export async function handleListCircles(req, res, next) {
  try {
    const circles = await listMyCircles(req.user._id);
    return res.json({ data: { circles } });
  } catch (err) { next(err); }
}

export async function handlePreviewCircle(req, res, next) {
  try {
    const preview = await previewCircle(req.params.code);
    return res.json({ data: preview });
  } catch (err) { next(err); }
}

export async function handleJoinCircle(req, res, next) {
  try {
    const result = await joinByCode(req.params.code, req.user._id);
    return res.status(201).json({ data: result });
  } catch (err) { next(err); }
}

export async function handleGetCircle(req, res, next) {
  try {
    const detail = await getCircleDetail(req.params.id, req.user._id);
    return res.json({ data: detail });
  } catch (err) { next(err); }
}

export async function handleUpdatePayoutOrder(req, res, next) {
  try {
    await updatePayoutOrder(req.params.id, req.user._id, req.body.order);
    return res.json({ data: { updated: true } });
  } catch (err) { next(err); }
}

export async function handleStartCircle(req, res, next) {
  try {
    const circle = await startCircle(req.params.id, req.user._id);
    return res.json({ data: { circle } });
  } catch (err) { next(err); }
}
