# AjoLedger API Documentation

Base URL (production): `https://ajoledger-backend-73kr.onrender.com/api`
Base URL (local): `http://localhost:1929/api`

> **Sandbox mode.** All payments run through Paystack **test mode** and all payouts are simulated ledger entries. No real money moves anywhere in this API.

---

## Table of contents

1. [Conventions](#conventions)
2. [Authentication](#authentication)
3. [Error codes](#error-codes)
4. [Rate limiting](#rate-limiting)
5. [Health](#health)
6. [Auth](#auth)
7. [Circles](#circles)
8. [Payments](#payments)
9. [Webhooks](#webhooks)
10. [Ledger](#ledger)
11. [Trust profile](#trust-profile)
12. [Notifications](#notifications)
13. [Jobs (cron)](#jobs-cron)
14. [Domain reference](#domain-reference)

---

## Conventions

### Response envelope

Every successful response is wrapped in a `data` key:

```json
{ "data": { /* ... */ } }
```

Every error response is wrapped in an `error` key:

```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "Human-readable message",
    "details": [ { "field": "email", "message": "Invalid email address" } ]
  }
}
```

`details` is only present on `VALIDATION_ERROR` (422) responses.

### Money

All amounts are **integers in kobo** (1 naira = 100 kobo) everywhere in the API — request bodies, response bodies, and the database. The client converts to/from naira for display only. Minimum contribution: 10,000 kobo (₦100). Maximum: 100,000,000 kobo (₦1,000,000).

### Dates

All dates are ISO 8601 strings in UTC. The client renders them in Africa/Lagos time.

### IDs

All `:id` and `:userId` path parameters are MongoDB ObjectIds (24-character hex strings).

---

## Authentication

Protected endpoints require a JWT in the `Authorization` header:

```
Authorization: Bearer <token>
```

Get a token from `POST /auth/register` or `POST /auth/login`. Tokens expire after `JWT_EXPIRES_IN` (default 7 days). There is no refresh-token flow — expired tokens require logging in again.

Endpoints marked **Public** require no authentication. Endpoints marked **Auth** require a valid Bearer token.

---

## Error codes

| Code | HTTP status | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 422 | Request body failed schema validation. `details` lists each field. |
| `BAD_REQUEST` | 400 | Request is well-formed but violates a business rule (e.g. wrong circle status). |
| `UNAUTHORIZED` | 401 | Missing/invalid/expired token, or wrong login credentials. |
| `FORBIDDEN` | 403 | Authenticated, but not allowed to perform this action (e.g. non-organizer). |
| `NOT_FOUND` | 404 | Resource doesn't exist, or exists but you're not authorized to know that (see note below). |
| `CONFLICT` | 409 | Duplicate resource, or a race condition (e.g. circle just filled up). |
| `RATE_LIMITED` | 429 | Too many requests from this IP. |
| `PAYSTACK_ERROR` | 502 | Paystack API was unreachable or returned an error. |
| `SIMULATION_ERROR` | 500 | The demo `/simulate` endpoint failed; message includes the real error (demo-only). |
| `INTERNAL_ERROR` | 500 | Unexpected server error. Message is generic in production. |

**Privacy-preserving 404s:** Several endpoints intentionally return `404 NOT_FOUND` instead of `403 FORBIDDEN` when you're not authorized to see a resource (e.g. requesting a circle you're not a member of). This prevents leaking *whether a resource exists* to people who shouldn't know. Don't rely on 403 vs 404 to distinguish "doesn't exist" from "exists but not yours" on these routes — they're called out below.

---

## Rate limiting

| Scope | Limit | Applies to |
|---|---|---|
| Auth | 10 requests/minute/IP | `POST /auth/register`, `POST /auth/login` |
| Public trust | 60 requests/minute/IP | `GET /public/trust/:slug` |

Exceeding a limit returns `429 RATE_LIMITED`.

---

## Health

### `GET /health`
**Public.** Use this to check the API and database are up (e.g. for uptime pings).

**Response `200`:**
```json
{
  "data": {
    "status": "ok",
    "db": "connected",
    "time": "2026-09-25T10:00:00.000Z"
  }
}
```

---

## Auth

### `POST /auth/register`
**Public.** Rate-limited (10/min/IP).

**Body:**
| Field | Type | Rules |
|---|---|---|
| `name` | string | 2–60 characters |
| `email` | string | valid email, lowercased/trimmed server-side |
| `password` | string | 8–72 characters |

**Response `201`:**
```json
{
  "data": {
    "token": "eyJhbGciOi...",
    "user": {
      "_id": "66f...",
      "name": "Ada Okafor",
      "email": "ada@example.com",
      "trust": { "slug": "ada-x7k2m9pq", "isPublic": false },
      "createdAt": "2026-09-25T10:00:00.000Z"
    }
  }
}
```

**Errors:** `CONFLICT` (409) if the email is already registered. `VALIDATION_ERROR` (422) for bad input.

### `POST /auth/login`
**Public.** Rate-limited (10/min/IP).

**Body:** `{ "email": "string", "password": "string" }`

**Response `200`:** same shape as register.

**Errors:** `UNAUTHORIZED` (401) — deliberately generic ("Invalid email or password") for both a wrong password and an unknown email, and the server runs a dummy bcrypt comparison on unknown emails so response timing doesn't reveal which case occurred.

### `GET /auth/me`
**Auth.**

**Response `200`:** `{ "data": { "user": { /* same shape as above */ } } }`

---

## Circles

A circle moves through three statuses: `forming` → `active` → `completed`.

### `POST /circles`
**Auth.** Creates a new circle. The creator becomes its organizer at payout position 1.

**Body:**
| Field | Type | Rules |
|---|---|---|
| `name` | string | 3–60 characters |
| `contributionKobo` | integer | 10,000–100,000,000 (₦100–₦1,000,000) |
| `frequency` | string | `weekly` \| `biweekly` \| `monthly` |
| `maxMembers` | integer | 2–12 |
| `startDate` | ISO date string | today or later |
| `graceDays` | integer | 0–5, default 2 |

**Response `201`:**
```json
{
  "data": {
    "circle": { "_id": "...", "name": "Office Ajo", "status": "forming", "...": "..." },
    "inviteUrl": "https://sjr-ajoledger.vercel.app/join/A1B2C3D4"
  }
}
```

### `GET /circles`
**Auth.** Lists every circle the caller belongs to, with a per-circle summary (member count, current cycle, next due date, the caller's own obligation status for the current cycle). Organizers also see `inviteCode` in the list.

**Response `200`:** `{ "data": { "circles": [ { ... } ] } }`

### `GET /circles/join/:code`
**Public.** Preview a circle by its invite code before joining — no auth needed, so it can be shared as a link.

**Response `200`:**
```json
{
  "data": {
    "circleId": "...",
    "name": "Office Ajo",
    "organizer": { "firstName": "Ada" },
    "contributionKobo": 2000000,
    "frequency": "monthly",
    "maxMembers": 5,
    "spotsLeft": 2,
    "status": "forming",
    "joinable": true,
    "reason": null
  }
}
```
`reason` explains why `joinable` is `false` (e.g. `"This circle is full"`) when applicable.

**Errors:** `NOT_FOUND` (404) for an invalid code.

### `POST /circles/join/:code`
**Auth.** Joins the circle at the next available payout position.

**Response `201`:** `{ "data": { "circleId": "...", "position": 3 } }`

**Errors:** `NOT_FOUND` (404) invalid code · `BAD_REQUEST` (400) circle already active/completed · `CONFLICT` (409) already a member, circle full, or lost a race for the last spot.

### `GET /circles/:id`
**Auth, members only.** Full circle detail: members (each with `trust: {score, tier}`), the current cycle (with `expectedPotKobo`), the caller's own obligation, every member's obligation for the current cycle, and — once cycle 2+ is open — a `lastClosedCycle` summary (who missed, who received, the pot).

**Errors:** `NOT_FOUND` (404) — returned for non-members too, so circle existence isn't leaked.

### `PATCH /circles/:id/payout-order`
**Auth, organizer only, circle must be `forming`.**

**Body:** `{ "order": ["userId1", "userId2", "..."] }` — must contain exactly the circle's current member IDs, in the desired payout order.

**Response `200`:** `{ "data": { "updated": true } }`

**Errors:** `FORBIDDEN` (403) not organizer · `BAD_REQUEST` (400) not forming · `VALIDATION_ERROR` (422) order doesn't match current members.

### `POST /circles/:id/start`
**Auth, organizer only, circle must be `forming`, ≥2 members.**

Creates every cycle up front (cycle *k*'s due date = `startDate + (k−1)` periods, clamped for month-end on `monthly`), opens cycle 1, and creates a pending obligation for every member.

**Response `200`:** `{ "data": { "circle": { "status": "active", "totalCycles": 5, "...": "..." } } }`

**Errors:** `FORBIDDEN` (403) not organizer · `BAD_REQUEST` (400) not forming, or fewer than 2 members.

### `DELETE /circles/:id/members/:userId`
**Auth, organizer only, circle must be `forming`.** Removes a member before the circle starts. Remaining members are renumbered 1..N (gap-free), and the invite code is **rotated** so the removed member can't rejoin with the old link.

**Response `200`:**
```json
{ "data": { "removed": true, "membersRemaining": 4, "inviteUrl": "https://.../join/NEWCODE" } }
```

**Errors:** `FORBIDDEN` (403) not organizer · `BAD_REQUEST` (400) not forming, or trying to remove yourself · `NOT_FOUND` (404) target isn't a member.

### `POST /circles/:id/contribute`
**Auth, members only.** Starts a Paystack checkout for the caller's current pending obligation. The amount is always read from the obligation server-side — **never** trust an amount from the client.

**Response `200`:**
```json
{ "data": { "authorizationUrl": "https://checkout.paystack.com/...", "reference": "AJT_66f.._a1B2c3D4" } }
```

Redirect the browser to `authorizationUrl`. Paystack redirects back to `${CLIENT_URL}/payments/callback?reference=...` after payment.

**Errors:** `NOT_FOUND` (404) not a member · `BAD_REQUEST` (400) circle not active, no open cycle, obligation already resolved, or the cycle's contribution window has closed · `PAYSTACK_ERROR` (502) Paystack unreachable.

### `POST /circles/:id/simulate`
**Auth, organizer only, `DEMO_MODE=true` only** (returns `404` otherwise, as if the route doesn't exist). Fast-forwards the circle's internal clock for demoing without waiting real time.

**Body:** `{ "action": "pass-due-date" | "close-cycle" }`
- `pass-due-date` — jumps to 1 hour past the current cycle's due date and fires overdue reminders.
- `close-cycle` — jumps to 1 minute past the grace deadline and closes the cycle (missed obligations, payout, next cycle opens).

**Response `200`:**
```json
{
  "data": {
    "action": "close-cycle",
    "simulatedNow": "2026-10-25T00:01:00.000Z",
    "engineSummary": [ { "circleId": "...", "circleName": "Office Ajo", "cyclesClosed": 1, "missedCount": 1 } ],
    "reminderSummary": { "notificationsCreated": 3, "emailsSent": 2 }
  }
}
```

**Errors:** `404` if `DEMO_MODE=false` · `FORBIDDEN` (403) not organizer · `BAD_REQUEST` (400) circle not active or no open cycle. A failed simulation returns `500 SIMULATION_ERROR` with the real underlying error message (safe to expose — this endpoint is demo-only and organizer-gated).

---

## Payments

### `GET /payments/verify/:reference`
**Auth, owner only.** Called by the frontend's payment-callback page after Paystack redirects back. Verifies the transaction with Paystack and settles it (idempotent — safe to call more than once for the same reference, including a concurrent webhook call).

**Response `200`:**
```json
{
  "data": {
    "payment": { "reference": "AJT_...", "status": "success", "...": "..." },
    "obligation": { "status": "paid_on_time", "...": "..." },
    "settled": true,
    "alreadySettled": false
  }
}
```

If Paystack reports anything other than a clean successful match (status, currency, amount, and reference all verified), `settled` is `false` and `reason` explains why (`currency_mismatch`, `amount_mismatch: ...`, `reference_mismatch`, or Paystack's own status string).

**Errors:** `NOT_FOUND` (404) unknown reference · `FORBIDDEN` (403) reference belongs to another user.

---

## Webhooks

### `POST /webhooks/paystack`
**Not for client use.** Configure this URL in your Paystack dashboard (Settings → API Keys & Webhooks). Verifies `x-paystack-signature` (HMAC-SHA512 of the raw request body) with a timing-safe comparison, acknowledges immediately with `200`, then settles `charge.success` events asynchronously in the background. All other event types are acknowledged and ignored. Invalid signatures get `401`.

---

## Ledger

Every circle has its own **append-only, hash-chained ledger**. Entries can never be edited or deleted — this is enforced at the database layer (Mongoose middleware throws on any update/delete against `LedgerEntry`), not just in application logic.

### `GET /circles/:id/ledger`
**Auth, members only.** Cursor-paginated, ascending by `seq`.

**Query params:** `limit` (default 20, max 50), `cursor` (last seen `seq`; omit for the first page).

**Response `200`:**
```json
{
  "data": {
    "entries": [
      {
        "seq": 1,
        "cycleNumber": 1,
        "type": "contribution",
        "user": { "_id": "...", "name": "Ada Okafor" },
        "amountKobo": 2000000,
        "reference": "AJT_...",
        "sandbox": true,
        "prevHash": "GENESIS",
        "hash": "9f2a...",
        "createdAt": "2026-09-25T10:00:00.000Z"
      }
    ],
    "nextCursor": 1,
    "hasMore": true
  }
}
```

`type` is one of `contribution` | `payout` | `missed`.

### `GET /circles/:id/ledger/verify`
**Auth, members only.** Re-walks the whole chain and re-computes every hash to confirm nothing has been tampered with.

**Response `200` (intact):** `{ "data": { "ok": true, "checked": 14 } }`
**Response `200` (broken):** `{ "data": { "ok": false, "checked": 8, "brokenAtSeq": 9, "reason": "Hash mismatch at seq 9" } }`

### `GET /circles/:id/ledger.csv`
**Auth, members only.** Downloads the full ledger as a CSV file (`Content-Disposition: attachment`). Columns: `seq, timestamp_iso, cycle, type, member, amount_ngn, reference, sandbox, prev_hash, hash`. UTF-8 BOM + CRLF line endings for Excel compatibility; cells are escaped against CSV formula injection.

---

## Trust profile

Every user has a **Reliability Score** computed from their contribution history across all circles, and an optional public profile page they can share.

### `GET /me/trust`
**Auth.** The caller's own full trust profile.

**Response `200`:**
```json
{
  "data": {
    "score": 92.5,
    "tier": "excellent",
    "label": "Exceptional — always pays on time",
    "onTime": 11,
    "late": 1,
    "missed": 0,
    "resolved": 12,
    "circlesJoined": 3,
    "circlesCompleted": 1,
    "memberSince": "2026-06-01T00:00:00.000Z",
    "slug": "ada-x7k2m9pq",
    "isPublic": false,
    "publicUrl": "https://sjr-ajoledger.vercel.app/t/ada-x7k2m9pq"
  }
}
```

If the caller has fewer than 3 resolved obligations, `score` is `null` and `tier` is `"building"` — there isn't enough history for a meaningful score yet.

### `PATCH /me/trust`
**Auth.** Update sharing settings.

**Body:** `{ "isPublic"?: boolean, "regenerateSlug"?: boolean }`

Regenerating the slug immediately invalidates the old public link.

**Response `200`:** `{ "data": { "slug": "...", "isPublic": true, "publicUrl": "..." } }`

### `GET /public/trust/:slug`
**Public.** No auth, rate-limited (60/min/IP), cached 60 seconds. Returns the exact same `404 NOT_FOUND` body whether the slug doesn't exist **or** the profile is private — this is deliberate, so a private profile can't be distinguished from a nonexistent one.

**Response `200`:**
```json
{
  "data": {
    "displayName": "Ada O.",
    "score": 92.5,
    "tier": "excellent",
    "tierLabel": "Exceptional — always pays on time",
    "counts": { "onTime": 11, "late": 1, "missed": 0 },
    "resolvedCount": 12,
    "circlesCompleted": 1,
    "memberSince": "June 2026",
    "disclaimer": "Built from tamper-evident circle ledgers. Scores are computed from sandbox data. No real money moved."
  }
}
```

This is an intentional **allow-list projection** — email, exact join date, circle names, and amounts are never included, by design, not by omission.

---

## Notifications

### `GET /notifications`
**Auth.** The caller's 30 most recent notifications, newest first, plus an unread count.

**Response `200`:** `{ "data": { "notifications": [ { "_id", "kind", "title", "body", "circle", "readAt", "createdAt" } ], "unreadCount": 3 } }`

`kind` is one of: `cycle_open`, `payment_received`, `payment_missed`, `payout_sent`, `reminder`, `circle_completed`, `member_joined`.

### `POST /notifications/read-all`
**Auth.** Marks every unread notification as read.

**Response `200`:** `{ "data": { "ok": true, "marked": 3 } }`

### `PATCH /notifications/:id/read`
**Auth, owner only.** Marks a single notification read. Idempotent — safe to call more than once.

**Response `200`:** `{ "data": { "ok": true, "notification": { ... } } }`

---

## Jobs (cron)

### `POST /jobs/run`
**Not for client use — protected by a secret, not a user token.** Runs the cycle engine (closes any due cycles) then reminders (sends due/overdue notifications and emails) across every active circle. Intended to be called by an external scheduler (e.g. cron-job.org) so background processing works even on hosts that don't keep a process alive 24/7.

**Header:** `x-cron-secret: <CRON_SECRET>` (compared with a timing-safe check)

**Response `200`:**
```json
{
  "data": {
    "engine": [ { "circleId": "...", "circleName": "Office Ajo", "cyclesClosed": 1, "missedCount": 0 } ],
    "reminders": { "notificationsCreated": 4, "emailsSent": 4 },
    "ranAt": "2026-09-25T10:00:00.000Z"
  }
}
```

**Errors:** `UNAUTHORIZED` (401) missing/wrong secret.

---

## Domain reference

### Status enums

| Field | Values |
|---|---|
| Circle `status` | `forming` → `active` → `completed` |
| Cycle `status` | `scheduled` → `open` → `closed` |
| Obligation `status` | `pending` → `paid_on_time` \| `paid_late` \| `missed` |
| Payment `status` | `initialized` → `success` \| `failed` \| `abandoned` |
| LedgerEntry `type` | `contribution` \| `payout` \| `missed` |
| Trust `tier` | `building` (< 3 resolved obligations) → `poor` (< 50) → `fair` (≥ 50) → `good` (≥ 70) → `excellent` (≥ 90) |

### Reliability score

```
score = round( (onTime × 1 + late × 0.5) / resolved × 100, 1 decimal )
```
where `resolved = onTime + late + missed`. Requires at least 3 resolved obligations, otherwise the score is `null` ("building" tier).

### Ledger hash chain

Each entry's `hash` is a SHA-256 hex digest of a canonical JSON array:
```
[seq, circle, cycleNumber, user, type, amountKobo, reference ?? null, sandbox, createdAt (ISO), prevHash]
```
`prevHash` is the previous entry's `hash` (or the literal string `"GENESIS"` for the first entry in a circle). `GET /circles/:id/ledger/verify` recomputes this chain from scratch and reports the first broken link, if any — this is what makes tampering detectable rather than just theoretically prevented.

### Cycle timing

- `dueDate` for cycle *k* = `circle.startDate + (k−1)` periods (`weekly` = +7 days, `biweekly` = +14 days, `monthly` = +1 calendar month, clamped to month-end — e.g. Jan 31 + 1 month → Feb 28/29, not Mar 3).
- `closesAt` = `dueDate + graceDays`.
- A payment after `dueDate` but before `closesAt` is `paid_late`. After `closesAt`, the obligation is `missed` once the cycle closes and the contribution is rejected if attempted.
- `DEMO_MODE`'s `simulatedNow` overrides "now" for a circle everywhere in the domain logic (`circleNow(circle)`), so the whole engine, reminders, and late/on-time classification stay consistent under simulation.
