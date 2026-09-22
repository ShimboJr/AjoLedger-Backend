/**
 * Paystack REST API wrapper.
 *
 * - Only the two endpoints used in this app: initialize + verify.
 * - 10-second timeout via AbortSignal.
 * - Never logs the secret key or full response bodies.
 * - Amounts are in kobo (Paystack's unit for NGN).
 * - Throws on non-2xx or network errors so callers get a plain Error.
 */

import { env } from '../config/env.js';

const PAYSTACK_BASE = env.PAYSTACK_BASE_URL ?? 'https://api.paystack.co';

function authHeader() {
  return { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` };
}

/**
 * Raw fetch with 10 s timeout and terse error logging (no secrets).
 */
async function paystackFetch(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  let response;
  try {
    response = await fetch(`${PAYSTACK_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...authHeader(),
        ...options.headers,
      },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    // Network errors / abort — never include the URL (contains no secret, but keep clean)
    const msg = err.name === 'AbortError' ? 'Paystack request timed out' : 'Paystack network error';
    throw Object.assign(new Error(msg), { code: 'PAYSTACK_NETWORK', cause: err });
  }
  clearTimeout(timer);

  if (!response.ok) {
    // Log only status, never headers (which contain the Authorization key)
    console.error(`[paystack] ${options.method ?? 'GET'} ${path} → HTTP ${response.status}`);
    throw Object.assign(new Error(`Paystack API error: HTTP ${response.status}`), {
      code: 'PAYSTACK_API',
      httpStatus: response.status,
    });
  }

  return response.json();
}

/**
 * initializeTransaction — creates a Paystack checkout URL.
 *
 * @param {object} opts
 * @param {string} opts.email        - payer's email
 * @param {number} opts.amountKobo   - integer kobo
 * @param {string} opts.reference    - our unique reference (AJT_...)
 * @param {string} opts.callbackUrl  - where Paystack redirects after payment
 * @param {object} opts.metadata     - { obligationId, circleId, userId }
 * @returns {{ authorizationUrl: string, accessCode: string, reference: string }}
 */
export async function initializeTransaction({ email, amountKobo, reference, callbackUrl, metadata }) {
  const body = JSON.stringify({
    email,
    amount: amountKobo,     // kobo
    currency: 'NGN',
    reference,
    callback_url: callbackUrl,
    metadata: {
      obligationId: String(metadata.obligationId),
      circleId:     String(metadata.circleId),
      userId:       String(metadata.userId),
    },
  });

  const json = await paystackFetch('/transaction/initialize', { method: 'POST', body });

  // Official Paystack shape: { status: true, data: { authorization_url, access_code, reference } }
  if (!json.status) {
    throw Object.assign(new Error(`Paystack initialize failed: ${json.message}`), { code: 'PAYSTACK_INIT_FAILED' });
  }

  return {
    authorizationUrl: json.data.authorization_url,
    accessCode:       json.data.access_code,
    reference:        json.data.reference,
  };
}

/**
 * verifyTransaction — confirms a completed payment.
 *
 * @param {string} reference - our unique reference
 * @returns {object} sanitized Paystack transaction data
 *   shape: { status, currency, amount, reference, gateway_response, channel, paidAt }
 */
export async function verifyTransaction(reference) {
  // Encode the reference in case it contains special chars (it shouldn't, but safe)
  const json = await paystackFetch(`/transaction/verify/${encodeURIComponent(reference)}`);

  if (!json.status) {
    throw Object.assign(new Error(`Paystack verify failed: ${json.message}`), { code: 'PAYSTACK_VERIFY_FAILED' });
  }

  // Return only the fields we care about — never raw customer data
  const d = json.data;
  return {
    status:           d.status,           // 'success' | 'failed' | 'abandoned' | ...
    currency:         d.currency,         // 'NGN'
    amount:           d.amount,           // kobo (integer)
    reference:        d.reference,
    gateway_response: d.gateway_response, // human-readable result e.g. "Successful"
    channel:          d.channel,          // 'card' | 'bank' | ...
    paidAt:           d.paid_at,          // ISO string from Paystack
  };
}
