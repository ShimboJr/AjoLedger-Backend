/**
 * tests/payments.test.js
 *
 * Tests for:
 * (a) settlePayment success  → obligation paid, 1 ledger entry, verify intact
 * (b) settlePayment idempotency → called twice, 1 ledger entry, 1 obligation update
 * (c) amount mismatch → payment failed, 0 ledger entries
 * (d) POST /api/webhooks/paystack valid signature → 200
 * (e) POST /api/webhooks/paystack invalid signature → 401
 *
 * Paystack API calls are mocked with vi.mock so no real HTTP requests are made.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import supertest from 'supertest';
import mongoose from 'mongoose';
import { createHmac } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

// ── Mock paystackService BEFORE any imports that use it ───────────────────────
vi.mock('../src/services/paystackService.js', () => ({
  initializeTransaction: vi.fn(),
  verifyTransaction:     vi.fn(),
}));

// ── DB setup (ReplSet for transactions) ───────────────────────────────────────
let replSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { maxPoolSize: 10, serverSelectionTimeoutMS: 10000 });

  await import('../src/models/User.js');
  await import('../src/models/Circle.js');
  await import('../src/models/Membership.js');
  await import('../src/models/Cycle.js');
  await import('../src/models/Obligation.js');
  await import('../src/models/Payment.js');
  await import('../src/models/LedgerEntry.js');
  await import('../src/models/Notification.js');
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet.stop();
}, 30_000);

afterEach(async () => {
  for (const col of Object.values(mongoose.connection.collections)) {
    await col.deleteMany({});
  }
  vi.clearAllMocks();
});

// ── Lazy imports (after mocks are wired) ─────────────────────────────────────
async function getApp() { return (await import('../src/app.js')).default; }
const { settlePayment }       = await import('../src/services/payments.js');
const { verifyChain }         = await import('../src/services/ledger.js');
const paystackService         = await import('../src/services/paystackService.js');
const { LedgerEntry }         = await import('../src/models/LedgerEntry.js');
const { Payment }             = await import('../src/models/Payment.js');
const { Obligation }          = await import('../src/models/Obligation.js');

// ── Test-secret (mirrors vitest.setup.js) ─────────────────────────────────────
const TEST_SECRET = 'sk_test_placeholder_key_for_tests';

// ── Shared fixture builder ────────────────────────────────────────────────────
/**
 * Sets up: user, circle (active with 1 cycle open), obligation, and Payment record.
 * Returns { user, circle, cycle, obligation, payment, reference }.
 */
async function buildPaymentFixture(app, amountKobo = 50_000) {
  // Register organiser + one member
  const orgRes = await supertest(app).post('/api/auth/register')
    .send({ name: 'Chidi Org', email: 'chidi@test.com', password: 'password123' });
  const { token: orgToken, user: organizer } = orgRes.body.data;

  const memRes = await supertest(app).post('/api/auth/register')
    .send({ name: 'Ngozi Mem', email: 'ngozi@test.com', password: 'password123' });
  const { token: memToken, user: member } = memRes.body.data;

  // Create circle
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const cRes = await supertest(app).post('/api/circles')
    .set('Authorization', `Bearer ${orgToken}`)
    .send({
      name: 'Payment Test Circle',
      contributionKobo: amountKobo,
      frequency: 'monthly',
      maxMembers: 3,
      startDate: tomorrow.toISOString().slice(0, 10),
      graceDays: 2,
    });
  const circle = cRes.body.data.circle;

  // Member joins
  await supertest(app).post(`/api/circles/join/${circle.inviteCode}`)
    .set('Authorization', `Bearer ${memToken}`);

  // Start circle
  await supertest(app).post(`/api/circles/${circle._id}/start`)
    .set('Authorization', `Bearer ${orgToken}`);

  // Fetch the active circle + cycle
  const { Circle }     = await import('../src/models/Circle.js');
  const { Cycle }      = await import('../src/models/Cycle.js');
  const { Obligation } = await import('../src/models/Obligation.js');

  const activeCircle = await Circle.findById(circle._id).lean();
  const openCycle    = await Cycle.findOne({ circle: circle._id, status: 'open' }).lean();
  const obligation   = await Obligation.findOne({ cycle: openCycle._id, user: organizer._id }).lean();

  // Create an initialized Payment record for the organizer's obligation
  const reference = `AJT_${String(obligation._id)}_test0001`;
  await Payment.create({
    reference,
    circle:     circle._id,
    cycle:      openCycle._id,
    obligation: obligation._id,
    user:       organizer._id,
    amountKobo,
    currency:   'NGN',
    status:     'initialized',
  });

  const payment = await Payment.findOne({ reference }).lean();

  return {
    organizer,  orgToken,
    member,     memToken,
    circle:     activeCircle,
    cycle:      openCycle,
    obligation,
    payment,
    reference,
  };
}

// ── Helper: valid Paystack charge.success event payload ───────────────────────
function buildChargeSuccessPayload(reference, amount = 50_000) {
  return JSON.stringify({
    event: 'charge.success',
    data: { reference, status: 'success', amount, currency: 'NGN' },
  });
}

function paystackSig(body) {
  return createHmac('sha512', TEST_SECRET).update(body).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite A: settlePayment — service-level tests
// ─────────────────────────────────────────────────────────────────────────────

describe('settlePayment', () => {
  it('(a) success: marks obligation paid_on_time, payment success, exactly 1 ledger entry, chain intact', async () => {
    const app = await getApp();
    const { obligation, payment, reference, circle, cycle } = await buildPaymentFixture(app);

    // Mock Paystack verify → success
    paystackService.verifyTransaction.mockResolvedValueOnce({
      status:           'success',
      currency:         'NGN',
      amount:           payment.amountKobo,
      reference,
      gateway_response: 'Successful',
      channel:          'card',
      paidAt:           new Date().toISOString(),
    });

    const result = await settlePayment(reference);

    expect(result.settled).toBe(true);
    expect(result.alreadySettled).toBeFalsy();
    expect(['paid_on_time', 'paid_late']).toContain(result.obligation.status);

    const updatedPayment = await Payment.findOne({ reference }).lean();
    expect(updatedPayment.status).toBe('success');
    expect(updatedPayment.settledAt).toBeTruthy();

    const entries = await LedgerEntry.find({ circle: circle._id }).lean();
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('contribution');
    expect(entries[0].reference).toBe(reference);
    expect(entries[0].amountKobo).toBe(payment.amountKobo);

    // Chain integrity
    const verify = await verifyChain(circle._id);
    expect(verify.ok).toBe(true);
    expect(verify.checked).toBe(1);
  });

  it('(b) idempotency: settling the same reference twice yields ONE obligation update and ONE ledger entry', async () => {
    const app = await getApp();
    const { payment, reference, circle } = await buildPaymentFixture(app);

    const mockTxn = {
      status:           'success',
      currency:         'NGN',
      amount:           payment.amountKobo,
      reference,
      gateway_response: 'Successful',
      channel:          'card',
      paidAt:           new Date().toISOString(),
    };

    // First settle
    paystackService.verifyTransaction.mockResolvedValueOnce(mockTxn);
    const first = await settlePayment(reference);
    expect(first.settled).toBe(true);

    // Second settle — Paystack mock not called again (already success)
    const second = await settlePayment(reference);
    expect(second.alreadySettled).toBe(true);

    // verifyTransaction only called ONCE (idempotent check avoids the second call)
    expect(paystackService.verifyTransaction).toHaveBeenCalledTimes(1);

    // Exactly one ledger entry
    const entries = await LedgerEntry.find({ circle: circle._id }).lean();
    expect(entries).toHaveLength(1);

    // Obligation updated once
    const obs = await Obligation.find({ reference }).lean();
    expect(obs).toHaveLength(1);
  });

  it('(c) amount mismatch: payment marked failed, no ledger entry', async () => {
    const app = await getApp();
    const { payment, reference, circle } = await buildPaymentFixture(app, 50_000);

    // Paystack reports a different amount
    paystackService.verifyTransaction.mockResolvedValueOnce({
      status:   'success',
      currency: 'NGN',
      amount:   1,           // ← mismatch
      reference,
      gateway_response: 'Successful',
      channel:  'card',
      paidAt:   new Date().toISOString(),
    });

    const result = await settlePayment(reference);
    expect(result.settled).toBe(false);
    expect(result.reason).toMatch(/amount_mismatch/);

    const updatedPayment = await Payment.findOne({ reference }).lean();
    expect(updatedPayment.status).toBe('failed');

    const entries = await LedgerEntry.find({ circle: circle._id }).lean();
    expect(entries).toHaveLength(0);
  });

  it('rejected Paystack status (abandoned): payment marked failed', async () => {
    const app = await getApp();
    const { payment, reference } = await buildPaymentFixture(app);

    paystackService.verifyTransaction.mockResolvedValueOnce({
      status:   'abandoned',
      currency: 'NGN',
      amount:   payment.amountKobo,
      reference,
      gateway_response: 'Transaction abandoned',
      channel:  'card',
      paidAt:   null,
    });

    const result = await settlePayment(reference);
    expect(result.settled).toBe(false);

    const updatedPayment = await Payment.findOne({ reference }).lean();
    expect(updatedPayment.status).toBe('failed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite B: POST /api/webhooks/paystack — signature verification
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/webhooks/paystack', () => {
  it('(d) valid signature → 200 (charge.success)', async () => {
    const app = await getApp();
    const body = buildChargeSuccessPayload('AJT_test_dummy001');
    const sig  = paystackSig(body);

    // Mock settlePayment so it doesn't throw on a missing reference
    paystackService.verifyTransaction.mockResolvedValue({
      status: 'failed', currency: 'NGN', amount: 0, reference: 'AJT_test_dummy001',
      gateway_response: 'Declined', channel: 'card', paidAt: null,
    });

    const res = await supertest(app)
      .post('/api/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', sig)
      .send(body);

    expect(res.status).toBe(200);
  });

  it('(e) invalid signature → 401', async () => {
    const app = await getApp();
    const body = buildChargeSuccessPayload('AJT_test_dummy002');

    const res = await supertest(app)
      .post('/api/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', 'deadadbeefdeadbeef')
      .send(body);

    expect(res.status).toBe(401);
  });

  it('missing signature → 401', async () => {
    const app = await getApp();
    const body = buildChargeSuccessPayload('AJT_test_dummy003');

    const res = await supertest(app)
      .post('/api/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(401);
  });

  it('non-charge.success event is acknowledged (200) and ignored', async () => {
    const app = await getApp();
    const body = JSON.stringify({ event: 'transfer.success', data: {} });
    const sig  = paystackSig(body);

    const res = await supertest(app)
      .post('/api/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', sig)
      .send(body);

    expect(res.status).toBe(200);
    // verifyTransaction must not be called for non-charge events
    expect(paystackService.verifyTransaction).not.toHaveBeenCalled();
  });

  it('callback-verify + webhook for the same reference: still one ledger entry', async () => {
    const app = await getApp();
    const { payment, reference, circle, orgToken } = await buildPaymentFixture(app);

    const mockTxn = {
      status:           'success',
      currency:         'NGN',
      amount:           payment.amountKobo,
      reference,
      gateway_response: 'Successful',
      channel:          'card',
      paidAt:           new Date().toISOString(),
    };

    // Mock enough times for both calls (callback + webhook trigger settle once each,
    // but the second call short-circuits on alreadySettled)
    paystackService.verifyTransaction.mockResolvedValue(mockTxn);

    // 1. Browser callback verify (auth required)
    const verifyRes = await supertest(app)
      .get(`/api/payments/verify/${reference}`)
      .set('Authorization', `Bearer ${orgToken}`);
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.data.settled).toBe(true);

    // 2. Webhook delivery for the same reference (even if simultaneous, settle is idempotent)
    const webhookBody = buildChargeSuccessPayload(reference, payment.amountKobo);
    const sig = paystackSig(webhookBody);
    const webhookRes = await supertest(app)
      .post('/api/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', sig)
      .send(webhookBody);
    expect(webhookRes.status).toBe(200);

    // Allow webhook async settle to run
    await new Promise((r) => setTimeout(r, 200));

    // Still exactly ONE ledger entry
    const entries = await LedgerEntry.find({ circle: circle._id }).lean();
    expect(entries).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite C: POST /api/circles/:id/contribute
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/circles/:id/contribute', () => {
  it('returns authorizationUrl and reference for a pending obligation', async () => {
    const app = await getApp();
    const { circle, orgToken, payment } = await buildPaymentFixture(app);

    paystackService.initializeTransaction.mockResolvedValueOnce({
      authorizationUrl: 'https://checkout.paystack.com/test123',
      accessCode:       'acc_test',
      reference:        'AJT_will_be_ignored', // our ref is generated server-side
    });

    const res = await supertest(app)
      .post(`/api/circles/${circle._id}/contribute`)
      .set('Authorization', `Bearer ${orgToken}`);

    // The organizer already has an initialized payment in the fixture
    // so handleContribute re-initializes with the existing reference
    expect(res.status).toBe(200);
    expect(res.body.data.authorizationUrl).toBe('https://checkout.paystack.com/test123');
    expect(res.body.data.reference).toBeTruthy();
  });

  it('non-member cannot contribute', async () => {
    const app = await getApp();
    const { circle } = await buildPaymentFixture(app);

    const strangerRes = await supertest(app).post('/api/auth/register')
      .send({ name: 'Stranger', email: 'stranger@test.com', password: 'password123' });
    const strangerToken = strangerRes.body.data.token;

    const res = await supertest(app)
      .post(`/api/circles/${circle._id}/contribute`)
      .set('Authorization', `Bearer ${strangerToken}`);

    expect(res.status).toBe(404);
  });
});
