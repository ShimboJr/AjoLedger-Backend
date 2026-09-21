import mongoose from 'mongoose';

const { Schema } = mongoose;

const membershipSchema = new Schema(
  {
    circle: {
      type: Schema.Types.ObjectId,
      ref: 'Circle',
      required: true,
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    position: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: 'position must be an integer',
      },
    },
    role: {
      type: String,
      enum: ['organizer', 'member'],
      default: 'member',
    },
    joinedAt: {
      type: Date,
      default: () => new Date(),
    },
  },
  { timestamps: false }
);

// Indexes — defined exactly once
membershipSchema.index({ circle: 1, user: 1 }, { unique: true });
membershipSchema.index({ circle: 1, position: 1 }, { unique: true });
membershipSchema.index({ user: 1 });

export const Membership = mongoose.model('Membership', membershipSchema);
