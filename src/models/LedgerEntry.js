import mongoose from 'mongoose';

const { Schema } = mongoose;

const MUTATION_HOOKS = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndDelete',
  'deleteOne',
  'deleteMany',
  'replaceOne',
];

const ledgerEntrySchema = new Schema(
  {
    circle: {
      type: Schema.Types.ObjectId,
      ref: 'Circle',
      required: true,
    },
    seq: {
      type: Number,
      required: true,
      validate: {
        validator: Number.isInteger,
        message: 'seq must be an integer',
      },
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
    type: {
      type: String,
      enum: ['contribution', 'payout', 'missed'],
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
    reference: {
      type: String,
      // No default — omit entirely for entries without a reference (engine/payout/missed).
      // The sparse unique index only enforces uniqueness on documents where this field EXISTS.
      // Setting default:null caused every null to collide on the index.
    },
    sandbox: {
      type: Boolean,
      default: true,
    },
    meta: {
      type: Schema.Types.Mixed,
      default: {},
    },
    prevHash: {
      type: String,
      required: true,
    },
    hash: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// Indexes — defined exactly once
ledgerEntrySchema.index({ circle: 1, seq: 1 }, { unique: true });
ledgerEntrySchema.index({ reference: 1 }, { unique: true, sparse: true });
ledgerEntrySchema.index({ circle: 1, user: 1 });

// ── Append-only guard ────────────────────────────────────────────────────────
// Block all mutation operations on LedgerEntry at the schema level.

MUTATION_HOOKS.forEach((hook) => {
  ledgerEntrySchema.pre(hook, function () {
    throw new Error(`LedgerEntry is append-only: "${hook}" is not permitted`);
  });
});

// Block save() on an existing (already-persisted) document
ledgerEntrySchema.pre('save', function () {
  if (!this.isNew) {
    throw new Error('LedgerEntry is append-only: updating an existing entry is not permitted');
  }
});

export const LedgerEntry = mongoose.model('LedgerEntry', ledgerEntrySchema);
