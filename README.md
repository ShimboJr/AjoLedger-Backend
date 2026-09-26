# AjoLedger Backend

> **Save together. Provably.**

AjoLedger is a REST API for rotating savings circles (ajo/esusu/susu). It provides authentication, circle management, contribution obligations, Paystack payment verification, an append-only tamper-evident ledger, notifications, scheduled cycle processing, CSV exports, and shareable Reliability/Trust Profiles.

> **Sandbox / demo notice:** The application is designed for demonstration and sandbox workflows. The public Trust Profile explicitly states that scores are computed from sandbox data and that no real money is moved.

## Live Resources

| Resource | Link |
|---|---|
| Backend repository | https://github.com/ShimboJr/AjoLedger-Backend |
| Frontend repository | https://github.com/ShimboJr/AjoLedger-Frontend |
| Live application | https://sjr-ajoledger.vercel.app |
| Production API | https://ajoledger-backend-73kr.onrender.com |
| API health check | https://ajoledger-backend-73kr.onrender.com/api/health |

## What the Backend Does

- JWT authentication with registration, login, and current-user lookup
- Rotating savings circle creation and membership
- Invite-code based joining
- Organizer-controlled payout order
- Circle lifecycle: `forming → active → completed`
- Automatic cycle and contribution-obligation creation
- Paystack checkout initialization and server-side verification
- Paystack HMAC-SHA512 webhook verification
- Transactional payment settlement
- Append-only, hash-chained ledger
- Ledger verification and CSV export
- Reliability/Trust Score computation
- Optional public Trust Profiles
- In-app notifications
- Email reminders through console, SMTP, or Brevo
- Scheduled engine/reminder processing
- Protected external cron endpoint
- Demo time simulation for presentations
- Request validation, rate limiting, Helmet, CORS, and centralized errors
- Automated tests with Vitest, Supertest, and MongoDB Memory Server

---

## Architecture

```text
                         ┌─────────────────────────┐
                         │   AjoLedger React Client │
                         │         Vercel           │
                         └────────────┬────────────┘
                                      │ HTTPS / JSON
                                      ▼
                         ┌─────────────────────────┐
                         │   AjoLedger REST API    │
                         │   Express / Node 20     │
                         │         Render          │
                         └──────┬────────┬─────────┘
                                │        │
                 ┌──────────────┘        └─────────────────┐
                 ▼                                          ▼
        ┌─────────────────┐                        ┌────────────────┐
        │ MongoDB / Atlas │                        │    Paystack    │
        │ Users / Circles │                        │ Checkout +     │
        │ Cycles / Ledger │                        │ Verification   │
        └─────────────────┘                        └────────────────┘
                 │
                 ▼
        ┌─────────────────┐
        │ Engine / Cron   │
        │ Reminders /     │
        │ Notifications   │
        └─────────────────┘
```

---

## Core Flow

```text
Register / Login
      │
      ▼
Create Circle ──► Invite Members
      │
      ▼
Set Payout Order
      │
      ▼
Start Circle
      │
      ▼
Cycles + Obligations
      │
      ▼
Paystack Contribution
      │
      ▼
Server Verification
      │
      ├──► Obligation updated
      ├──► Cycle pot updated
      └──► Ledger entry appended
      │
      ▼
Engine advances cycles
      │
      ├──► Missed payments
      ├──► Payout events
      └──► Completion
      │
      ▼
Reliability / Trust Profile
```

---

## Technology Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ |
| Framework | Express 4 |
| Database | MongoDB / MongoDB Atlas |
| ODM | Mongoose 8 |
| Authentication | JWT |
| Password hashing | bcryptjs |
| Validation | Zod |
| Payments | Paystack |
| Email | Nodemailer / Brevo |
| Scheduling | node-cron |
| Security | Helmet, CORS, express-rate-limit |
| Testing | Vitest, Supertest, MongoDB Memory Server |
| Hosting | Render |

---

## API Documentation

The full endpoint reference is available in:

```text
API_DOCUMENTATION.md
```

It covers:

- Authentication
- Circle management
- Ledger operations
- Payments
- Notifications
- Trust Profiles
- Public Trust Profiles
- Demo simulation
- Scheduled jobs
- Paystack webhooks
- Error formats
- Security behavior
- Environment configuration

### API Base URL

Production:

```text
https://ajoledger-backend-73kr.onrender.com/api
```

Local example:

```text
http://localhost:1929/api
```

---

## API Highlights

### Authentication

```http
POST /api/auth/register
POST /api/auth/login
GET  /api/auth/me
```

Protected requests use:

```http
Authorization: Bearer <JWT>
```

### Circles

```http
POST   /api/circles
GET    /api/circles
GET    /api/circles/join/:code
POST   /api/circles/join/:code
GET    /api/circles/:id
PATCH  /api/circles/:id/payout-order
POST   /api/circles/:id/start
DELETE /api/circles/:id/members/:userId
```

### Ledger

```http
GET /api/circles/:id/ledger
GET /api/circles/:id/ledger/verify
GET /api/circles/:id/ledger.csv
```

### Payments

```http
POST /api/circles/:id/contribute
GET  /api/payments/verify/:reference
POST /api/webhooks/paystack
```

### Trust

```http
GET   /api/me/trust
PATCH /api/me/trust
GET   /api/public/trust/:slug
```

### Notifications

```http
GET   /api/notifications
PATCH /api/notifications/:id/read
POST  /api/notifications/read-all
```

---

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | — | `development` \| `production` \| `test` |
| `PORT` | — | defaults to 3000; `.env.example` uses 1929 |
| `MONGODB_URI` | ✅ | MongoDB Atlas connection string |
| `JWT_SECRET` | ✅ | ≥ 32 characters |
| `JWT_EXPIRES_IN` | — | default `7d` |
| `CLIENT_URL` | ✅ | your deployed frontend's URL — used for CORS and invite/callback links |
| `PAYSTACK_SECRET_KEY` | ✅ | must start with `sk_` — use `sk_test_...` |
| `PAYSTACK_BASE_URL` | — | default `https://api.paystack.co` |
| `MAIL_TRANSPORT` | — | `console` (default, safe) \| `smtp` \| `brevo` — see [Email delivery](#email-delivery) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | only if `MAIL_TRANSPORT=smtp` | — |
| `BREVO_API_KEY` | only if `MAIL_TRANSPORT=brevo` | from Brevo → Settings → SMTP & API |
| `MAIL_FROM` | — | must match a Brevo-verified sender when using `brevo` mode |
| `REMINDER_DAYS_BEFORE` | — | default 2 |
| `ENABLE_CRON` | — | `true`/`false`, default `false` — runs the in-process 15-minute scheduler |
| `CRON_SECRET` | ✅ | ≥ 32 characters — required regardless of `ENABLE_CRON` |
| `DEMO_MODE` | — | `true`/`false`, default `true` — gates the `/circles/:id/simulate` endpoint |

---

## Email delivery

**Render's free tier blocks outbound SMTP ports** (25, 465, 587), so `MAIL_TRANSPORT=smtp` will time out once deployed there, even though it works locally. Two working alternatives, both over plain HTTPS:

- **`console`** (default) — logs emails instead of sending them. Zero setup, always works.
- **`brevo`** — sends via Brevo's HTTPS transactional email API. Only needs a single **verified sender email** (no domain/DNS ownership required) — see [brevo.com](https://www.brevo.com). Free tier: 300 emails/day.

---

## Ledger Design

The ledger is designed to be append-only and tamper-evident.

Each entry contains:

- `seq`
- `cycleNumber`
- `user`
- `type`
- `amountKobo`
- `reference`
- `prevHash`
- `hash`
- `meta`
- `sandbox`

The Mongoose schema blocks mutation operations on existing ledger records.

Members can request a chain verification:

```http
GET /api/circles/:id/ledger/verify
```

The ledger can also be exported:

```http
GET /api/circles/:id/ledger.csv
```

---

## Payment Security

The contribution amount is never accepted from the browser.

Instead:

1. The API finds the member's current pending obligation.
2. The amount is read from that obligation.
3. A unique internal Paystack reference is generated.
4. The payment record is stored.
5. Paystack checkout is initialized.
6. After payment, Paystack is verified server-side.
7. Status, currency, amount, and reference are checked.
8. Settlement updates the obligation, cycle pot, and ledger transactionally.

Paystack webhooks are verified using HMAC-SHA512.

---

## Reliability / Trust Profiles

The Trust system aggregates resolved obligations:

- `paid_on_time` = 1
- `paid_late` = 0.5
- `missed` = 0

A score is only calculated after at least three resolved obligations.

Users can:

- view their private trust profile,
- publish it,
- regenerate its public slug,
- share a public URL.

Public responses intentionally exclude sensitive fields such as email and individual payment amounts.

---

## Scheduled Processing

The backend contains an engine for:

- opening/advancing cycles,
- identifying missed obligations,
- generating payout/completion events,
- creating notifications.

The reminder service handles:

- due-soon reminders,
- due-today reminders,
- overdue reminders,
- email delivery,
- engine notification emails.

### Built-in scheduler

```env
ENABLE_CRON=true
```

Runs every 15 minutes.

### External scheduler

```http
POST /api/jobs/run
x-cron-secret: <CRON_SECRET>
```

This is useful for hosts that may sleep between requests.

---

## Demo Mode

The API includes an organizer-only time simulation endpoint:

```http
POST /api/circles/:id/simulate
```

Request:

```json
{
  "action": "pass-due-date"
}
```

or:

```json
{
  "action": "close-cycle"
}
```

It is enabled only when:

```env
DEMO_MODE=true
```

This makes it possible to demonstrate overdue reminders and cycle closure without waiting for real dates.

---

## Security Controls

- JWT authentication
- bcrypt password hashing
- Zod input validation
- Helmet security headers
- CORS restrictions
- Authentication rate limiting
- Public trust rate limiting
- Timing-safe cron-secret comparison
- HMAC-SHA512 Paystack webhook verification
- Server-side payment amount enforcement
- Payment ownership checks
- Transactional payment settlement
- Idempotent payment settlement
- Append-only ledger enforcement
- Sanitized user responses
- Public trust field allow-list
- Production-safe error responses
- Sensitive query parameter masking in request logs

---

## Environment Variables

Create `.env` from `.env.example`.

```env
NODE_ENV=development
PORT=1929

MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/ajoledger?retryWrites=true&w=majority

JWT_SECRET=change-me-to-a-long-random-secret
JWT_EXPIRES_IN=7d

CLIENT_URL=http://localhost:5173

PAYSTACK_SECRET_KEY=sk_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
PAYSTACK_BASE_URL=https://api.paystack.co

MAIL_TRANSPORT=console

BREVO_API_KEY=

SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=

MAIL_FROM=noreply@ajoledger.example.com

REMINDER_DAYS_BEFORE=2
ENABLE_CRON=false
CRON_SECRET=change-me-to-another-long-random-secret
DEMO_MODE=true
```

### Production

At minimum, configure:

```text
MONGODB_URI
JWT_SECRET
CLIENT_URL
PAYSTACK_SECRET_KEY
CRON_SECRET
```

Use long random secrets for `JWT_SECRET` and `CRON_SECRET`.

---

## Installation

### Requirements

- Node.js 20+
- MongoDB / MongoDB Atlas
- Paystack test account/secret key for payment testing

### Setup

```bash
git clone https://github.com/ShimboJr/AjoLedger-Backend.git
cd AjoLedger-Backend

npm install

cp .env.example .env
```

Fill in `.env`, then:

```bash
npm run dev
```

---

## NPM Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start development server with Node watch mode |
| `npm start` | Start production server |
| `npm test` | Run Vitest test suite |
| `npm run test:watch` | Run Vitest in watch mode |
| `npm run seed` | Seed sandbox/demo data |
| `npm run seed:reset` | Reset/reseed sandbox/demo data |

---

## Testing

Run:

```bash
npm test
```

The test suite covers areas including:

- authentication
- circles
- payments
- ledger
- public trust profiles
- engine behavior
- CSV export
- dates
- mailer behavior

The test environment uses MongoDB Memory Server, allowing database-dependent tests without requiring the production database.

---

## Deployment

The production API is deployed on Render:

```text
https://ajoledger-backend-73kr.onrender.com
```

The frontend is deployed separately on Vercel:

```text
https://sjr-ajoledger.vercel.app
```

For production, set:

```env
NODE_ENV=production
CLIENT_URL=https://sjr-ajoledger.vercel.app
```

Then configure the MongoDB, Paystack, mail, and cron secrets in the hosting provider.

---

## Project Structure

```text
src/
├── app.js
├── server.js
├── config/
│   ├── brand.js
│   ├── db.js
│   └── env.js
├── controllers/
│   ├── authController.js
│   ├── circleController.js
│   ├── ledgerController.js
│   ├── paymentController.js
│   └── webhookController.js
├── jobs/
│   └── scheduler.js
├── middleware/
│   ├── auth.js
│   ├── error.js
│   ├── rateLimit.js
│   └── validate.js
├── models/
│   ├── Circle.js
│   ├── Cycle.js
│   ├── LedgerEntry.js
│   ├── Membership.js
│   ├── Notification.js
│   ├── Obligation.js
│   ├── Payment.js
│   └── User.js
├── routes/
│   ├── auth.js
│   ├── circles.js
│   ├── health.js
│   ├── jobs.js
│   ├── me.js
│   ├── notifications.js
│   ├── payments.js
│   ├── public.js
│   └── webhook.js
├── scripts/
│   └── seed.js
├── services/
│   ├── authService.js
│   ├── circleService.js
│   ├── cycleService.js
│   ├── csv.js
│   ├── engine.js
│   ├── ledger.js
│   ├── mailerService.js
│   ├── payments.js
│   ├── paystackService.js
│   ├── reminders.js
│   └── trust.js
└── utils/
    ├── dates.js
    ├── hash.js
    ├── ids.js
    └── money.js

tests/
├── auth.test.js
├── circles.test.js
├── csv.test.js
├── dates.test.js
├── engine.test.js
├── ledger.test.js
├── mailer.test.js
├── payments.test.js
└── public.test.js
```

---

## Screenshots / API Demonstration

### API Health Check

![API Health check](docs/screenshots/health-check.png)

### Login

![Login](docs/screenshots/login.png) 

### Circles List

![Circles List](docs/screenshots/circles.png)

### Circle / Ledger Flow

![Circle Detail](docs/screenshots/circle-detail.png)

### Ledger Verification

![Ledger verify](docs/screenshots/ledger-verification.png)

### Payment Verification

![Payment verify](docs/screenshots/payment-verification.png)

### Public Trust Profile

![Public Trust](docs/screenshots/public-trust.png)

---

## Frontend

The companion React application is available at:

https://github.com/ShimboJr/AjoLedger-Frontend

Live:

https://sjr-ajoledger.vercel.app

---

## License

MIT
