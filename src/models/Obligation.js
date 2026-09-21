import mongoose from 'mongoose';

const { Schema } = mongoose;

const obligationSchema = new Schema(
  {
    circle: {
      type: Schema.Types.ObjectId,
      ref: 'Circle',
      required: true,
    },
    cycle: {
      type: Schema.Types.ObjectId,
      ref: 'Cycle',
      required: true,
    },
    cycleNumber: {
      type: Number,
      required: true,
      validate: {
        validator: Number.isInteger,
        message: 'cycleNumber must be an integer',
      },
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    amountKobo: {
      type: Number,
      required: true,
      validate: {
        validator: Number.isInteger,
        message: 'amountKobo must be an integer',
      },
    },
    status: {
      type: String,
      enum: ['pending', 'paid_on_time', 'paid_late', 'missed'],
      default: 'pending',
    },
    paidAt: {
      type: Date,
      default: null,
    },
    reference: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// Indexes — defined exactly once
obligationSchema.index({ cycle: 1, user: 1 }, { unique: true });
obligationSchema.index({ circle: 1, user: 1, status: 1 });
obligationSchema.index({ reference: 1 }, { sparse: true });

export const Obligation = mongoose.model('Obligation', obligationSchema);
