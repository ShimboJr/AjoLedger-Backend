import mongoose from 'mongoose';

const { Schema } = mongoose;

const notificationSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    circle: {
      type: Schema.Types.ObjectId,
      ref: 'Circle',
      default: null,
    },
    kind: {
      type: String,
      required: true,
      enum: [
        'cycle_open',
        'payment_received',
        'payment_missed',
        'payout_sent',
        'reminder',
        'circle_completed',
        'member_joined',
      ],
    },
    title: {
      type: String,
      required: true,
      maxlength: 120,
    },
    body: {
      type: String,
      required: true,
      maxlength: 500,
    },
    readAt: {
      type: Date,
      default: null,
    },
    emailStatus: {
      type: String,
      enum: ['sent', 'failed', 'skipped'],
      default: 'skipped',
    },
    dedupeKey: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// Indexes — defined exactly once
notificationSchema.index({ dedupeKey: 1 }, { unique: true });
notificationSchema.index({ user: 1, readAt: 1 });
notificationSchema.index({ user: 1, createdAt: -1 });

export const Notification = mongoose.model('Notification', notificationSchema);
