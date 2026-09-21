import { env } from './config/env.js';
import { connectDB } from './config/db.js';

// Import all models so Mongoose registers them and creates indexes on startup
import './models/User.js';
import './models/Circle.js';
import './models/Membership.js';
import './models/Cycle.js';
import './models/Obligation.js';
import './models/Payment.js';
import './models/LedgerEntry.js';
import './models/Notification.js';

import app from './app.js';

async function start() {
  await connectDB();

  app.listen(env.PORT, () => {
    console.log(`[server] AjoLedger API running on port ${env.PORT} (${env.NODE_ENV})`);
    if (env.DEMO_MODE) {
      console.log('[server] DEMO_MODE is enabled — simulation endpoints are active');
    }
  });
}

start();
