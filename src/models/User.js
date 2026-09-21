import mongoose from 'mongoose';

const { Schema } = mongoose;

const trustSchema = new Schema(
  {
    slug: {
      type: String,
      lowercase: true,
    },
    isPublic: {
      type: Boolean,
      default: false,
    },
  },
  { _id: false }
);

const userSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 60,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: {
      type: String,
      required: true,
      select: false, // never returned in queries by default
    },
    trust: {
      type: trustSchema,
      default: () => ({ isPublic: false }),
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// Indexes — defined exactly once
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ 'trust.slug': 1 }, { unique: true, sparse: true });

export const User = mongoose.model('User', userSchema);
