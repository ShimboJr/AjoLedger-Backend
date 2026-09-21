import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import supertest from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Env vars are set in vitest.setup.js before this file runs.

let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();

  // Connect mongoose directly (bypass env.js URI for tests)
  await mongoose.connect(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 5000 });

  // Register models so indexes are created
  await import('../src/models/User.js');
  await import('../src/models/Circle.js');
  await import('../src/models/Membership.js');
  await import('../src/models/Cycle.js');
  await import('../src/models/Obligation.js');
  await import('../src/models/Payment.js');
  await import('../src/models/LedgerEntry.js');
  await import('../src/models/Notification.js');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  // Clean users between tests
  const { User } = await import('../src/models/User.js');
  await User.deleteMany({});
});

// Lazy-load app so env is set first
async function getApp() {
  const { default: app } = await import('../src/app.js');
  return app;
}

// ────────────────────────────────────────────────────────────────────────────

describe('POST /api/auth/register', () => {
  it('creates a user and returns token + user (no passwordHash)', async () => {
    const app = await getApp();
    const res = await supertest(app)
      .post('/api/auth/register')
      .send({ name: 'Amaka Obi', email: 'amaka@example.com', password: 'password123' });

    expect(res.status).toBe(201);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.token).toBeTypeOf('string');
    expect(res.body.data.user.email).toBe('amaka@example.com');
    expect(res.body.data.user.passwordHash).toBeUndefined();
    expect(res.body.data.user.trust?.slug).toBeTypeOf('string');
    expect(res.body.data.user.trust.slug.length).toBe(12);
  });

  it('returns 409 on duplicate email', async () => {
    const app = await getApp();
    const payload = { name: 'Amaka Obi', email: 'dup@example.com', password: 'password123' };
    await supertest(app).post('/api/auth/register').send(payload);
    const res = await supertest(app).post('/api/auth/register').send(payload);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('returns 422 for invalid email', async () => {
    const app = await getApp();
    const res = await supertest(app)
      .post('/api/auth/register')
      .send({ name: 'Test User', email: 'not-an-email', password: 'password123' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 422 for short password', async () => {
    const app = await getApp();
    const res = await supertest(app)
      .post('/api/auth/register')
      .send({ name: 'Test User', email: 'test@example.com', password: 'short' });

    expect(res.status).toBe(422);
  });
});

describe('POST /api/auth/login', () => {
  it('returns token + user on correct credentials', async () => {
    const app = await getApp();
    await supertest(app).post('/api/auth/register').send({
      name: 'Chidi Eze',
      email: 'chidi@example.com',
      password: 'mypassword99',
    });

    const res = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'chidi@example.com', password: 'mypassword99' });

    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeTypeOf('string');
    expect(res.body.data.user.passwordHash).toBeUndefined();
  });

  it('returns 401 with generic message on wrong password', async () => {
    const app = await getApp();
    await supertest(app).post('/api/auth/register').send({
      name: 'Chidi Eze',
      email: 'chidi2@example.com',
      password: 'mypassword99',
    });

    const res = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'chidi2@example.com', password: 'wrongpassword' });

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Invalid email or password');
  });

  it('returns 401 with generic message on unknown email', async () => {
    const app = await getApp();
    const res = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'ghost@example.com', password: 'somepassword' });

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Invalid email or password');
  });
});

describe('GET /api/auth/me', () => {
  it('returns 401 without a token', async () => {
    const app = await getApp();
    const res = await supertest(app).get('/api/auth/me');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns user when authenticated', async () => {
    const app = await getApp();
    const reg = await supertest(app).post('/api/auth/register').send({
      name: 'Ngozi Adeyemi',
      email: 'ngozi@example.com',
      password: 'securepass1',
    });
    const { token } = reg.body.data;

    const res = await supertest(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe('ngozi@example.com');
    expect(res.body.data.user.passwordHash).toBeUndefined();
  });

  it('returns 401 with a malformed token', async () => {
    const app = await getApp();
    const res = await supertest(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer not.a.real.token');

    expect(res.status).toBe(401);
  });
});
