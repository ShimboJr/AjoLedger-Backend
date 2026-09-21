/**
 * Vitest global setup — runs before any test file imports.
 * Sets all required env vars so env.js validation passes
 * and dotenv doesn't override with a .env file.
 */

// Prevent dotenv from loading the .env file during tests
process.env.DOTENV_CONFIG_PATH = '/nonexistent/.env.test-override';

process.env.NODE_ENV            = 'test';
process.env.PORT                = '3001'; // 0 fails zod .positive() check
process.env.MONGODB_URI         = 'mongodb://localhost:27017/ajo_test_placeholder';
process.env.JWT_SECRET          = 'test-secret-that-is-long-enough-32c';
process.env.JWT_EXPIRES_IN      = '1h';
process.env.CLIENT_URL          = 'http://localhost:5173';
process.env.PAYSTACK_SECRET_KEY = 'sk_test_placeholder_key_for_tests';
process.env.PAYSTACK_BASE_URL   = 'https://api.paystack.co';
process.env.MAIL_TRANSPORT      = 'console';
process.env.MAIL_FROM           = 'test@ajoledger.example.com';
process.env.REMINDER_DAYS_BEFORE = '2';
process.env.ENABLE_CRON         = 'false';
process.env.CRON_SECRET         = 'test-cron-secret-long-enough-32c';
process.env.DEMO_MODE           = 'true';
