/**
 * webhookController.js
 *
 * POST /api/webhooks/paystack
 *
 * Contract:
 * 1. Verify x-paystack-signature (HMAC-SHA512 of raw body) with timing-safe compare.
 * 2. Respond 200 immediately — Paystack expects a fast ACK.
 * 3. Asynchronously call settlePayment for charge.success events.
 * 4. Log errors without leaking secrets; return 200 for all handled/ignored events
 *    (but 401 on signature failure) so Paystack does not retry unnecessarily.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { settlePayment } from '../services/payments.js';

// ── Signature verification ────────────────────────────────────────────────────

function verifyPaystackSignature(rawBody, signature) {
  if (!signature || typeof signature !== 'string') return false;
  try {
    const expected = createHmac('sha512', env.PAYSTACK_SECRET_KEY)
      .update(rawBody)
      .digest('hex');

    const expectedBuf = Buffer.from(expected);
    const receivedBuf = Buffer.from(signature);

    // Lengths must match for timingSafeEqual — mismatched lengths are an immediate reject
    if (expectedBuf.length !== receivedBuf.length) return false;
    return timingSafeEqual(expectedBuf, receivedBuf);
  } catch {
    return false;
  }
}

// ── Webhook handler ───────────────────────────────────────────────────────────

export async function handlePaystackWebhook(req, res) {
  const signature = req.headers['x-paystack-signature'];

  // req.body is a Buffer (express.raw middleware), convert to string for HMAC
  const rawBody = req.body;

  if (!verifyPaystackSignature(rawBody, signature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Parse event — body is a Buffer at this point
  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    // Malformed JSON — ack 200 so Paystack doesn't retry (we can't do anything with it)
    console.error('[webhook] malformed JSON payload received');
    return res.sendStatus(200);
  }

  // Respond immediately so Paystack doesn't time out and retry
  res.sendStatus(200);

  // ── Handle events asynchronously (after response is flushed) ─────────────
  // Only process charge.success; acknowledge everything else silently.
  if (event.event !== 'charge.success') return;

  const reference = event.data?.reference;
  if (!reference) {
    console.error('[webhook] charge.success event missing reference');
    return;
  }

  // Fire-and-forget settle — log without leaking reference content (it's not secret, but keep logs clean)
  settlePayment(reference).catch((err) => {
    // Log enough to debug; avoid logging the Paystack secret or full payload
    console.error('[webhook] settlePayment error for charge.success', {
      code:    err.code,
      message: err.message,
    });
  });
}
