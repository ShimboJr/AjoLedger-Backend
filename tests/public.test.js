/**
 * public.test.js — tests for GET /api/public/trust/:slug
 *
 * Verified properties:
 *  - Unknown slug → identical 404 (same body as private)
 *  - Private profile (isPublic=false) → identical 404
 *  - Public profile → 200 with no email, no amounts, no circle names
 *  - Malformed slug (too short / bad chars) → 404
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import supertest from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri);

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
  await mongod.stop();
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

// Helper: set trust settings for a user
async function setTrust(app, token, opts) {
  return supertest(app)
    .patch('/api/me/trust')
    .set('Authorization', `Bearer ${token}`)
    .send(opts);
}

// ── GET /api/public/trust/:slug ───────────────────────────────────────────────

const NOT_FOUND_CODE = 'NOT_FOUND';

describe('GET /api/public/trust/:slug', () => {
  it('returns 404 for an unknown slug', async () => {
    const app = await getApp();
    const res = await supertest(app).get('/api/public/trust/completely-unknown-slug');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe(NOT_FOUND_CODE);
  });

  it('returns identical 404 for a private profile (same body as unknown)', async () => {
    const app = await getApp();
    const { token } = await registerUser(app, { name: 'Private Person', email: 'priv@test.com' });

    // Get my trust profile to discover the slug
    const profileRes = await supertest(app)
      .get('/api/me/trust')
      .set('Authorization', `Bearer ${token}`);
    expect(profileRes.status).toBe(200);
    const slug = profileRes.body.data.slug;

    // isPublic is false by default — should see 404
    const res = await supertest(app).get(`/api/public/trust/${slug}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe(NOT_FOUND_CODE);
  });

  it('returns 404 for malformed slug (too short)', async () => {
    const app = await getApp();
    const res = await supertest(app).get('/api/public/trust/ab'); // < 3 chars
    expect(res.status).toBe(404);
  });

  it('returns 404 for malformed slug (uppercase letters)', async () => {
    const app = await getApp();
    const res = await supertest(app).get('/api/public/trust/InvalidSlug');
    expect(res.status).toBe(404);
  });

  it('returns 200 with score data for a public profile', async () => {
    const app = await getApp();
    const { token } = await registerUser(app, { name: 'Ada Okafor', email: 'ada@test.com' });

    // Make profile public
    await setTrust(app, token, { isPublic: true });

    // Get slug
    const profileRes = await supertest(app)
      .get('/api/me/trust')
      .set('Authorization', `Bearer ${token}`);
    const slug = profileRes.body.data.slug;

    const res = await supertest(app).get(`/api/public/trust/${slug}`);
    expect(res.status).toBe(200);

    const { data } = res.body;
    expect(data).toBeDefined();
    expect(data.displayName).toBeDefined();
    // Score may be null (building) — that's fine
    expect(data).toHaveProperty('score');
    expect(data).toHaveProperty('tier');
    expect(data).toHaveProperty('counts');
  });

  it('NEVER returns email address in public trust response', async () => {
    const app = await getApp();
    const { token } = await registerUser(app, { name: 'Email Test', email: 'emailcheck@test.com' });
    await setTrust(app, token, { isPublic: true });

    const profileRes = await supertest(app)
      .get('/api/me/trust')
      .set('Authorization', `Bearer ${token}`);
    const slug = profileRes.body.data.slug;

    const res = await supertest(app).get(`/api/public/trust/${slug}`);
    expect(res.status).toBe(200);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('emailcheck@test.com');
    expect(body).not.toContain('email');
  });

  it('NEVER returns circle names or amounts in public trust response', async () => {
    const app = await getApp();
    const { token } = await registerUser(app, { name: 'Amount Test', email: 'amtcheck@test.com' });
    await setTrust(app, token, { isPublic: true });

    const profileRes = await supertest(app)
      .get('/api/me/trust')
      .set('Authorization', `Bearer ${token}`);
    const slug = profileRes.body.data.slug;

    const res = await supertest(app).get(`/api/public/trust/${slug}`);
    expect(res.status).toBe(200);

    const data = res.body.data;
    // These fields must NOT be present
    expect(data).not.toHaveProperty('circleName');
    expect(data).not.toHaveProperty('circleNames');
    expect(data).not.toHaveProperty('amountKobo');
    expect(data).not.toHaveProperty('contributions');
    expect(data).not.toHaveProperty('email');
    expect(data).not.toHaveProperty('passwordHash');
  });

  it('displayName uses first name + last initial only, never full surname', async () => {
    const app = await getApp();
    const { token } = await registerUser(app, { name: 'Amaka Obiora', email: 'amaka.obiora@test.com' });
    await setTrust(app, token, { isPublic: true });

    const profileRes = await supertest(app)
      .get('/api/me/trust')
      .set('Authorization', `Bearer ${token}`);
    const slug = profileRes.body.data.slug;

    const res = await supertest(app).get(`/api/public/trust/${slug}`);
    expect(res.status).toBe(200);

    const { displayName } = res.body.data;
    // Should be "Amaka O." — not the full surname "Obiora"
    expect(displayName).toMatch(/^Amaka O\./);
    expect(displayName).not.toContain('Obiora');
  });

  it('unknown vs private slug return identical 404 body (no information leak)', async () => {
    const app = await getApp();
    const { token } = await registerUser(app, { name: 'Private User', email: 'pvtleak@test.com' });

    const profileRes = await supertest(app)
      .get('/api/me/trust')
      .set('Authorization', `Bearer ${token}`);
    const slug = profileRes.body.data.slug;

    const [unknownRes, privateRes] = await Promise.all([
      supertest(app).get('/api/public/trust/completely-unknown-zzz'),
      supertest(app).get(`/api/public/trust/${slug}`),
    ]);

    expect(unknownRes.status).toBe(404);
    expect(privateRes.status).toBe(404);
    // Both should have identical bodies
    expect(unknownRes.body).toEqual(privateRes.body);
  });
});
