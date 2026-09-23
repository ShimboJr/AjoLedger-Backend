/**
 * notifications.js — routes under /api/notifications
 *
 * GET  /api/notifications      → mine, newest first, with unreadCount
 * POST /api/notifications/read-all → mark all as read
 */

import { Router }       from 'express';
import { requireAuth }  from '../middleware/auth.js';
import { Notification } from '../models/Notification.js';

const router = Router();

const PAGE_SIZE = 30;

/**
 * GET /api/notifications
 * Returns { notifications: [...], unreadCount: number }
 */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user._id;

    const [notifications, unreadCount] = await Promise.all([
      Notification.find({ user: userId })
        .sort({ createdAt: -1 })
        .limit(PAGE_SIZE)
        .lean(),
      Notification.countDocuments({ user: userId, readAt: null }),
    ]);

    res.json({ data: { notifications, unreadCount } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/notifications/read-all
 * Sets readAt = now on all unread notifications for the caller.
 */
router.post('/read-all', requireAuth, async (req, res, next) => {
  try {
    const { modifiedCount } = await Notification.updateMany(
      { user: req.user._id, readAt: null },
      { $set: { readAt: new Date() } }
    );
    res.json({ data: { ok: true, marked: modifiedCount } });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/notifications/:id/read
 * Marks a single notification as read (idempotent — safe to call twice).
 * Only the owning user may mark their own notification.
 */
router.patch('/:id/read', requireAuth, async (req, res, next) => {
  try {
    const notif = await Notification.findOne({
      _id:  req.params.id,
      user: req.user._id,      // ownership check
    });

    if (!notif) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Notification not found' } });
    }

    if (!notif.readAt) {
      notif.readAt = new Date();
      await notif.save();
    }

    res.json({ data: { ok: true, notification: notif.toObject() } });
  } catch (err) {
    next(err);
  }
});

export default router;
