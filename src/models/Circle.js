import mongoose from 'mongoose';

const { Schema } = mongoose;

const circleSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 80,
    },
    organizer: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    contributionKobo: {
      type: Number,
      required: true,
      min: 10_000,       // 100 naira minimum
      max: 100_000_000,  // 1,000,000 naira maximum
      validate: {
        validator: Number.isInteger,
        message: 'contributionKobo must be an integer',
      },
    },
    frequency: {
      type: String,
      enum: ['weekly', 'biweekly', 'monthly'],
      required: true,
    },
    maxMembers: {
      type: Number,
      required: true,
      min: 2,
      max: 12,
      validate: {
        validator: Number.isInteger,
        message: 'maxMembers must be an integer',
      },
    },
    startDate: {
      type: Date,
      required: true,
    },
    graceDays: {
      type: Number,
      default: 2,
      min: 0,
      max: 7,
      validate: {
        validator: Number.isInteger,
        message: 'graceDays must be an integer',
      },
    },
    status: {
      type: String,
      enum: ['forming', 'active', 'completed'],
      default: 'forming',
    },
    inviteCode: {
      type: String,
      required: true,
    },
    currentCycleNumber: {
      type: Number,
      default: 0,
    },
    totalCycles: {
      type: Number,
      default: 0,
    },
    simulatedNow: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// Indexes — defined exactly once
circleSchema.index({ inviteCode: 1 }, { unique: true });
circleSchema.index({ organizer: 1 });

export const Circle = mongoose.model('Circle', circleSchema);
