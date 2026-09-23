import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import supertest from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

// Env vars are set in vitest.setup.js
// MongoMemoryReplSet is required here because startCircle and updatePayoutOrder use transactions.

let replSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri();
  await mongoose.connect(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 10000 });

  // Register all models
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
  const cols = mongoose.connection.collections;
  for (const col of Object.values(cols)) {
    await col.deleteMany({});
  }
});

async function getApp() {
  const { default: app } = await import('../src/app.js');
  return app;
}

// Helper: register a user and return { token, user }
async function registerUser(app, { name, email, password } = {}) {
  name     = name     ?? `User ${Math.random().toString(36).slice(2, 7)}`;
  email    = email    ?? `${Math.random().toString(36).slice(2, 10)}@test.com`;
  password = password ?? 'password123';
  const res = await supertest(app).post('/api/auth/register').send({ name, email, password });
  return res.body.data;
}

// Helper: create a circle and return { circle, inviteUrl }
async function makeCircle(app, token, overrides = {}) {
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

  const res = await supertest(app)
    .post('/api/circles')
    .set('Authorization', `Bearer ${token}`)
    .send({
      name: 'Test Circle',
      contributionKobo: 50_000, // ₦500
      frequency: 'monthly',
      maxMembers: 5,
      startDate: tomorrow.toISOString().slice(0, 10),
      graceDays: 2,
      ...overrides,
    });

  expect(res.status, `createCircle failed: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body.data;
}

// ── POST /api/circles ────────────────────────────────────────────────────────

describe('POST /api/circles', () => {
  it('creates a circle and organizer membership at position 1', async () => {
    const app = await getApp();
    const { token, user } = await registerUser(app);

    const { circle, inviteUrl } = await makeCircle(app, token);

    expect(circle.status).toBe('forming');
    expect(circle.inviteCode).toHaveLength(8);
    expect(inviteUrl).toContain(`/join/${circle.inviteCode}`);
    expect(circle.organizer).toBe(String(user._id));
  });

  it('rejects contribution below 100 naira', async () => {
    const app = await getApp();
    const { token } = await registerUser(app);
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

    const res = await supertest(app)
      .post('/api/circles')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Bad Circle',
        contributionKobo: 5_000, // ₦50 — below minimum
        frequency: 'monthly',
        maxMembers: 5,
        startDate: tomorrow.toISOString().slice(0, 10),
      });

    expect(res.status).toBe(422);
  });

  it('rejects startDate in the past', async () => {
    const app = await getApp();
    const { token } = await registerUser(app);

    const res = await supertest(app)
      .post('/api/circles')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Past Circle',
        contributionKobo: 50_000,
        frequency: 'monthly',
        maxMembers: 5,
        startDate: '2020-01-01',
      });

    expect(res.status).toBe(422);
  });
});

// ── GET /api/circles/join/:code ──────────────────────────────────────────────

describe('GET /api/circles/join/:code', () => {
  it('returns preview for a valid code', async () => {
    const app = await getApp();
    const { token } = await registerUser(app, { name: 'Amaka Obi', email: 'amaka@t.com' });
    const { circle } = await makeCircle(app, token);

    const res = await supertest(app).get(`/api/circles/join/${circle.inviteCode}`);

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Test Circle');
    expect(res.body.data.joinable).toBe(true);
    expect(res.body.data.spotsLeft).toBe(4); // 5 max - 1 organizer
    expect(res.body.data.organizer.firstName).toBe('Amaka');
    // circleId should be present (needed for redirect after join)
    expect(res.body.data.circleId).toBeTruthy();
  });

  it('returns 404 for unknown code', async () => {
    const app = await getApp();
    const res = await supertest(app).get('/api/circles/join/unknownxx');
    expect(res.status).toBe(404);
  });
});

// ── POST /api/circles/join/:code ─────────────────────────────────────────────

describe('POST /api/circles/join/:code', () => {
  it('joins a circle and assigns the next position', async () => {
    const app = await getApp();
    const { token: org } = await registerUser(app);
    const { token: mem } = await registerUser(app);
    const { circle } = await makeCircle(app, org);

    const res = await supertest(app)
      .post(`/api/circles/join/${circle.inviteCode}`)
      .set('Authorization', `Bearer ${mem}`);

    expect(res.status).toBe(201);
    expect(res.body.data.position).toBe(2);
    expect(String(res.body.data.circleId)).toBe(String(circle._id));
  });

  it('duplicate join returns 409 (same user)', async () => {
    const app = await getApp();
    const { token: org } = await registerUser(app);
    const { token: mem } = await registerUser(app);
    const { circle } = await makeCircle(app, org);

    await supertest(app)
      .post(`/api/circles/join/${circle.inviteCode}`)
      .set('Authorization', `Bearer ${mem}`);

    // Second attempt by the same user
    const res = await supertest(app)
      .post(`/api/circles/join/${circle.inviteCode}`)
      .set('Authorization', `Bearer ${mem}`);

    expect(res.status).toBe(409);
  });

  it('returns 409 when circle is full', async () => {
    const app = await getApp();
    const { token: org } = await registerUser(app);
    // Circle with maxMembers=2 (organizer fills slot 1)
    const { circle } = await makeCircle(app, org, { maxMembers: 2 });

    const { token: mem1 } = await registerUser(app);
    await supertest(app)
      .post(`/api/circles/join/${circle.inviteCode}`)
      .set('Authorization', `Bearer ${mem1}`);

    // Third user — circle is now full
    const { token: mem2 } = await registerUser(app);
    const res = await supertest(app)
      .post(`/api/circles/join/${circle.inviteCode}`)
      .set('Authorization', `Bearer ${mem2}`);

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/full/i);
  });
});

// ── GET /api/circles/:id ─────────────────────────────────────────────────────

describe('GET /api/circles/:id', () => {
  it('returns 404 for a non-member', async () => {
    const app = await getApp();
    const { token: org } = await registerUser(app);
    const { token: stranger } = await registerUser(app);
    const { circle } = await makeCircle(app, org);

    const res = await supertest(app)
      .get(`/api/circles/${circle._id}`)
      .set('Authorization', `Bearer ${stranger}`);

    expect(res.status).toBe(404);
  });

  it('returns circle detail for a member', async () => {
    const app = await getApp();
    const { token: org } = await registerUser(app);
    const { circle } = await makeCircle(app, org);

    const res = await supertest(app)
      .get(`/api/circles/${circle._id}`)
      .set('Authorization', `Bearer ${org}`);

    expect(res.status).toBe(200);
    expect(res.body.data.circle.name).toBe('Test Circle');
    expect(res.body.data.members).toHaveLength(1);
    expect(res.body.data.isOrganizer).toBe(true);
    // Organizer can see inviteCode
    expect(res.body.data.circle.inviteCode).toBeTruthy();
  });

  it('hides inviteCode from non-organizer member', async () => {
    const app = await getApp();
    const { token: org } = await registerUser(app);
    const { token: mem } = await registerUser(app);
    const { circle } = await makeCircle(app, org);

    await supertest(app)
      .post(`/api/circles/join/${circle.inviteCode}`)
      .set('Authorization', `Bearer ${mem}`);

    const res = await supertest(app)
      .get(`/api/circles/${circle._id}`)
      .set('Authorization', `Bearer ${mem}`);

    expect(res.status).toBe(200);
    expect(res.body.data.circle.inviteCode).toBeUndefined();
  });
});

// ── POST /api/circles/:id/start ──────────────────────────────────────────────

describe('POST /api/circles/:id/start', () => {
  it('rejects start with only 1 member', async () => {
    const app = await getApp();
    const { token } = await registerUser(app);
    const { circle } = await makeCircle(app, token);

    const res = await supertest(app)
      .post(`/api/circles/${circle._id}/start`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/2 members/i);
  });

  it('starts circle with 2 members — creates all cycles and obligations', async () => {
    const app = await getApp();
    const { token: org } = await registerUser(app);
    const { token: mem } = await registerUser(app);
    const { circle } = await makeCircle(app, org, { maxMembers: 3, frequency: 'monthly' });

    await supertest(app)
      .post(`/api/circles/join/${circle.inviteCode}`)
      .set('Authorization', `Bearer ${mem}`);

    const res = await supertest(app)
      .post(`/api/circles/${circle._id}/start`)
      .set('Authorization', `Bearer ${org}`);

    expect(res.status).toBe(200);
    expect(res.body.data.circle.status).toBe('active');
    expect(res.body.data.circle.totalCycles).toBe(2);
    expect(res.body.data.circle.currentCycleNumber).toBe(1);

    // Verify cycle 1 is open with obligations for both members
    const detail = await supertest(app)
      .get(`/api/circles/${circle._id}`)
      .set('Authorization', `Bearer ${org}`);

    expect(detail.body.data.currentCycle.number).toBe(1);
    expect(detail.body.data.currentCycle.status).toBe('open');
    expect(detail.body.data.obligations).toHaveLength(2);
    expect(detail.body.data.obligations.every((o) => o.status === 'pending')).toBe(true);
    expect(detail.body.data.myObligation.status).toBe('pending');
  });

  it('non-organizer cannot start circle', async () => {
    const app = await getApp();
    const { token: org } = await registerUser(app);
    const { token: mem } = await registerUser(app);
    const { circle } = await makeCircle(app, org);

    await supertest(app)
      .post(`/api/circles/join/${circle.inviteCode}`)
      .set('Authorization', `Bearer ${mem}`);

    const res = await supertest(app)
      .post(`/api/circles/${circle._id}/start`)
      .set('Authorization', `Bearer ${mem}`);

    expect(res.status).toBe(403);
  });
});

// ── PATCH /api/circles/:id/payout-order ─────────────────────────────────────

describe('PATCH /api/circles/:id/payout-order', () => {
  it('reorders members correctly', async () => {
    const app = await getApp();
    const { token: org, user: orgUser } = await registerUser(app);
    const { token: mem, user: memUser } = await registerUser(app);
    const { circle } = await makeCircle(app, org);

    await supertest(app)
      .post(`/api/circles/join/${circle.inviteCode}`)
      .set('Authorization', `Bearer ${mem}`);

    // Reverse the order: mem first, org second
    const res = await supertest(app)
      .patch(`/api/circles/${circle._id}/payout-order`)
      .set('Authorization', `Bearer ${org}`)
      .send({ order: [String(memUser._id), String(orgUser._id)] });

    expect(res.status).toBe(200);

    // Verify new positions
    const detail = await supertest(app)
      .get(`/api/circles/${circle._id}`)
      .set('Authorization', `Bearer ${org}`);

    expect(detail.body.data.members[0].user._id).toBe(String(memUser._id));
    expect(detail.body.data.members[0].position).toBe(1);
    expect(detail.body.data.members[1].user._id).toBe(String(orgUser._id));
    expect(detail.body.data.members[1].position).toBe(2);
  });

  it('rejects order with unknown user ID', async () => {
    const app = await getApp();
    const { token: org } = await registerUser(app);
    const { token: mem } = await registerUser(app);
    const { circle } = await makeCircle(app, org);

    await supertest(app)
      .post(`/api/circles/join/${circle.inviteCode}`)
      .set('Authorization', `Bearer ${mem}`);

    const fakeId = new (await import('mongoose')).default.Types.ObjectId();

    const res = await supertest(app)
      .patch(`/api/circles/${circle._id}/payout-order`)
      .set('Authorization', `Bearer ${org}`)
      .send({ order: [String(fakeId), String(fakeId)] });

    expect(res.status).toBe(422);
  });

  it('non-organizer cannot reorder', async () => {
    const app = await getApp();
    const { token: org, user: orgUser } = await registerUser(app);
    const { token: mem, user: memUser } = await registerUser(app);
    const { circle } = await makeCircle(app, org);

    await supertest(app)
      .post(`/api/circles/join/${circle.inviteCode}`)
      .set('Authorization', `Bearer ${mem}`);

    const res = await supertest(app)
      .patch(`/api/circles/${circle._id}/payout-order`)
      .set('Authorization', `Bearer ${mem}`)
      .send({ order: [String(memUser._id), String(orgUser._id)] });

    expect(res.status).toBe(403);
  });
});

// ── DELETE /api/circles/:id/members/:userId ──────────────────────────────────

describe('DELETE /api/circles/:id/members/:userId', () => {
  it('organizer removes a member: membership deleted, positions renumbered, invite code rotated', async () => {
    const app = await getApp();
    const { token: org } = await registerUser(app);
    const { token: mem, user: memUser } = await registerUser(app);
    const { circle } = await makeCircle(app, org, { maxMembers: 5 });

    // Member joins — they are at position 2
    await supertest(app)
      .post(`/api/circles/join/${circle.inviteCode}`)
      .set('Authorization', `Bearer ${mem}`);

    const originalInviteCode = circle.inviteCode;

    const res = await supertest(app)
      .delete(`/api/circles/${circle._id}/members/${memUser._id}`)
      .set('Authorization', `Bearer ${org}`);

    expect(res.status).toBe(200);
    expect(res.body.data.removed).toBe(true);
    expect(res.body.data.membersRemaining).toBe(1); // only organizer left

    // Verify member is gone from the detail response
    const detail = await supertest(app)
      .get(`/api/circles/${circle._id}`)
      .set('Authorization', `Bearer ${org}`);

    expect(detail.body.data.members).toHaveLength(1);
    expect(detail.body.data.members[0].position).toBe(1); // positions renumbered

    // Invite code must have been rotated
    expect(detail.body.data.circle.inviteCode).not.toBe(originalInviteCode);
  });

  it('non-organizer cannot remove a member → 403', async () => {
    const app = await getApp();
    const { token: org } = await registerUser(app);
    const { token: mem1 } = await registerUser(app);
    const { token: mem2, user: mem2User } = await registerUser(app);
    const { circle } = await makeCircle(app, org, { maxMembers: 5 });

    await supertest(app).post(`/api/circles/join/${circle.inviteCode}`).set('Authorization', `Bearer ${mem1}`);
    await supertest(app).post(`/api/circles/join/${circle.inviteCode}`).set('Authorization', `Bearer ${mem2}`);

    const res = await supertest(app)
      .delete(`/api/circles/${circle._id}/members/${mem2User._id}`)
      .set('Authorization', `Bearer ${mem1}`); // not the organizer

    expect(res.status).toBe(403);
  });

  it('organizer cannot remove themselves → 400', async () => {
    const app = await getApp();
    const { token: org, user: orgUser } = await registerUser(app);
    const { circle } = await makeCircle(app, org);

    const res = await supertest(app)
      .delete(`/api/circles/${circle._id}/members/${orgUser._id}`)
      .set('Authorization', `Bearer ${org}`);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/yourself/i);
  });

  it('cannot remove a member once circle is active → 400', async () => {
    const app = await getApp();
    const { token: org } = await registerUser(app);
    const { token: mem, user: memUser } = await registerUser(app);
    const { circle } = await makeCircle(app, org, { maxMembers: 5 });

    await supertest(app).post(`/api/circles/join/${circle.inviteCode}`).set('Authorization', `Bearer ${mem}`);
    await supertest(app).post(`/api/circles/${circle._id}/start`).set('Authorization', `Bearer ${org}`);

    const res = await supertest(app)
      .delete(`/api/circles/${circle._id}/members/${memUser._id}`)
      .set('Authorization', `Bearer ${org}`);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/forming/i);
  });

  it('removing a non-member returns 404', async () => {
    const app = await getApp();
    const { token: org } = await registerUser(app);
    const { user: stranger } = await registerUser(app);
    const { circle } = await makeCircle(app, org);

    const res = await supertest(app)
      .delete(`/api/circles/${circle._id}/members/${stranger._id}`)
      .set('Authorization', `Bearer ${org}`);

    expect(res.status).toBe(404);
  });
});
