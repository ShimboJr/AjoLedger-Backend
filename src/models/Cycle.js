import mongoose from 'mongoose';

const { Schema } = mongoose;

const cycleSchema = new Schema(
  {
    circle: {
      type: Schema.Types.ObjectId,
      ref: 'Circle',
      required: true,
    },
    number: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: 'number must be an integer',
      },
    },
    dueDate: {
      type: Date,
      required: true,
    },
    closesAt: {
      type: Date,
      required: true,
    },
    recipient: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    status: {
      type: String,
      enum: ['scheduled', 'open', 'closed'],
      default: 'scheduled',
    },
    closedAt: {
      type: Date,
      default: null,
    },
    potKobo: {
      type: Number,
      default: 0,
      validate: {
        validator: Number.isInteger,
        message: 'potKobo must be an integer',
      },
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// Indexes — defined exactly once
cycleSchema.index({ circle: 1, number: 1 }, { unique: true });
cycleSchema.index({ circle: 1, status: 1 });

export const Cycle = mongoose.model('Cycle', cycleSchema);
