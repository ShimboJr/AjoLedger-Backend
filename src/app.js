import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';

import { env } from './config/env.js';
import { errorHandler } from './middleware/error.js';

// Route modules
import authRouter   from './routes/auth.js';
import healthRouter from './routes/health.js';

const app = express();

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet());

// ── CORS — allowlist only CLIENT_URL ─────────────────────────────────────────
app.use(
  cors({
    origin: env.CLIENT_URL,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// ── Request logger (morgan) ───────────────────────────────────────────────────
// Custom format that never prints Authorization headers or request bodies.
// We deliberately avoid body logging; morgan only logs headers by default.
morgan.token('safe-url', (req) => {
  // Mask any ?token= or ?password= query params
  const url = req.originalUrl || req.url;
  return url.replace(/([?&])(token|password|secret)=[^&]*/gi, '$1$2=***');
});

if (env.NODE_ENV !== 'test') {
  app.use(
    morgan(':method :safe-url :status :res[content-length] - :response-time ms', {
      skip: (_req, res) => res.statusCode < 400 && env.NODE_ENV === 'production',
    })
  );
}

// ── RAW BODY — webhook route must be mounted HERE, before JSON parser ─────────
// Day 3: import and mount paystackWebhookRouter here (needs express.raw body).
// Example:
//   import webhookRouter from './routes/webhook.js';
//   app.use('/api/webhooks', express.raw({ type: 'application/json' }), webhookRouter);
// ─────────────────────────────────────────────────────────────────────────────

// ── JSON body parser — 100kb limit ───────────────────────────────────────────
app.use(express.json({ limit: '100kb' }));

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/health', healthRouter);
app.use('/api/auth',   authRouter);

// Day 2+: mount additional routers here
// app.use('/api/circles',       circlesRouter);
// app.use('/api/payments',      paymentsRouter);
// app.use('/api/me',            meRouter);
// app.use('/api/notifications', notificationsRouter);
// app.use('/api/public',        publicRouter);
// app.use('/api/jobs',          jobsRouter);

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
});

// ── Central error handler (must be last) ─────────────────────────────────────
app.use(errorHandler);

export default app;
