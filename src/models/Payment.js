import mongoose from 'mongoose';

const { Schema } = mongoose;

const paymentSchema = new Schema(
  {
    reference: {
      type: String,
      required: true,
    },
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
    obligation: {
      type: Schema.Types.ObjectId,
      ref: 'Obligation',
      required: true,
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
    currency: {
      type: String,
      default: 'NGN',
    },
    status: {
      type: String,
      enum: ['initialized', 'success', 'failed'],
      default: 'initialized',
    },
    settledAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// Indexes — defined exactly once
paymentSchema.index({ reference: 1 }, { unique: true });
paymentSchema.index({ user: 1 });
paymentSchema.index({ circle: 1 });

export const Payment = mongoose.model('Payment', paymentSchema);
