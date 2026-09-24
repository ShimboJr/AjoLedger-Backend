/**
 * mailer.test.js — unit tests for sendMail() transport branches.
 *
 * The env is pre-set to MAIL_TRANSPORT=console in vitest.setup.js.
 * Each brevo test overrides env.MAIL_TRANSPORT (and env.BREVO_API_KEY)
 * directly on the imported env object for the duration of the test,
 * then restores them in afterEach.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendMail } from '../src/services/mailerService.js';
import { env }      from '../src/config/env.js';

// ── helpers ────────────────────────────────────────────────────────────────────

function mockFetch(status, body) {
  return vi.fn(() =>
    Promise.resolve({
      ok:     status >= 200 && status < 300,
      status,
      text:   () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
      json:   () => Promise.resolve(body),
    })
  );
}

// ── setup / teardown ───────────────────────────────────────────────────────────

let originalTransport;
let originalApiKey;

beforeEach(() => {
  originalTransport = env.MAIL_TRANSPORT;
  originalApiKey    = env.BREVO_API_KEY;
});

afterEach(() => {
  env.MAIL_TRANSPORT = originalTransport;
  env.BREVO_API_KEY  = originalApiKey;
  vi.restoreAllMocks();
});

// ── console transport ──────────────────────────────────────────────────────────

describe('sendMail — console transport', () => {
  it('returns {status:"sent"} and never throws', async () => {
    env.MAIL_TRANSPORT = 'console';
    const result = await sendMail({ to: 'a@b.com', subject: 'Hi', text: 'hello', html: '<p>hello</p>' });
    expect(result.status).toBe('sent');
  });

  it('returns {status:"skipped"} when to is falsy', async () => {
    env.MAIL_TRANSPORT = 'console';
    const result = await sendMail({ to: '', subject: 'Hi', text: 'hello', html: '' });
    expect(result.status).toBe('skipped');
  });
});

// ── brevo transport ────────────────────────────────────────────────────────────

describe('sendMail — brevo transport', () => {
  beforeEach(() => {
    env.MAIL_TRANSPORT = 'brevo';
    env.BREVO_API_KEY  = 'xkeysib-test-key';
  });

  it('returns {status:"failed"} on a non-2xx response without throwing', async () => {
    vi.stubGlobal('fetch', mockFetch(400, '{"code":"unauthorized","message":"Key not found"}'));

    const result = await sendMail({ to: 'a@b.com', subject: 'Test', text: 'hi', html: '<p>hi</p>' });
    expect(result).toEqual({ status: 'failed' });
  });

  it('returns {status:"failed"} on a 5xx response without throwing', async () => {
    vi.stubGlobal('fetch', mockFetch(500, 'Internal Server Error'));

    const result = await sendMail({ to: 'a@b.com', subject: 'Test', text: 'hi', html: '<p>hi</p>' });
    expect(result).toEqual({ status: 'failed' });
  });

  it('returns {status:"failed"} on a network error without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Network failure'))));

    const result = await sendMail({ to: 'a@b.com', subject: 'Test', text: 'hi', html: '<p>hi</p>' });
    expect(result).toEqual({ status: 'failed' });
  });

  it('returns {status:"failed"} on AbortError (timeout) without throwing', async () => {
    const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(abortErr)));

    const result = await sendMail({ to: 'a@b.com', subject: 'Test', text: 'hi', html: '<p>hi</p>' });
    expect(result).toEqual({ status: 'failed' });
  });

  it('returns {status:"sent", messageId} on a 201 response', async () => {
    vi.stubGlobal('fetch', mockFetch(201, { messageId: '<abc123@brevo>' }));

    const result = await sendMail({ to: 'a@b.com', subject: 'Test', text: 'hi', html: '<p>hi</p>' });
    expect(result.status).toBe('sent');
    expect(result.messageId).toBe('<abc123@brevo>');
  });

  it('posts to the correct Brevo endpoint with api-key header (not Bearer)', async () => {
    const fetchMock = mockFetch(201, { messageId: '<xyz@brevo>' });
    vi.stubGlobal('fetch', fetchMock);

    await sendMail({ to: 'a@b.com', subject: 'Test', text: 'hi', html: '<p>hi</p>' });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(opts.headers['api-key']).toBe('xkeysib-test-key');
    expect(opts.headers['Authorization']).toBeUndefined();
    expect(opts.method).toBe('POST');

    const body = JSON.parse(opts.body);
    expect(body.to).toEqual([{ email: 'a@b.com' }]);
    expect(body.htmlContent).toBe('<p>hi</p>');
    expect(body.textContent).toBe('hi');
    expect(body.sender).toMatchObject({ email: expect.any(String) });
  });
});
