import { z } from 'zod';
import dotenv from 'dotenv';

// In test environments, vitest.setup.js sets DOTENV_CONFIG_PATH to a non-existent
// path to prevent the .env file from overriding test env vars.
// In all other environments, dotenv loads .env from the default location.
dotenv.config(process.env.DOTENV_CONFIG_PATH ? { path: process.env.DOTENV_CONFIG_PATH } : {});


const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  CLIENT_URL: z.string().url('CLIENT_URL must be a valid URL'),
  PAYSTACK_SECRET_KEY: z.string().startsWith('sk_', 'PAYSTACK_SECRET_KEY must start with sk_'),
  PAYSTACK_BASE_URL: z.string().url().default('https://api.paystack.co'),
  MAIL_TRANSPORT: z.enum(['smtp', 'console']).default('console'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().email('MAIL_FROM must be a valid email').default('noreply@ajoledger.example.com'),
  REMINDER_DAYS_BEFORE: z.coerce.number().int().nonnegative().default(2),
  ENABLE_CRON: z.enum(['true', 'false']).transform((v) => v === 'true').default('false'),
  CRON_SECRET: z.string().min(16, 'CRON_SECRET must be at least 16 characters'),
  DEMO_MODE: z.enum(['true', 'false']).transform((v) => v === 'true').default('true'),
});

// Refine: if MAIL_TRANSPORT=smtp, SMTP fields are required
const refinedSchema = envSchema.superRefine((data, ctx) => {
  if (data.MAIL_TRANSPORT === 'smtp') {
    if (!data.SMTP_HOST) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'SMTP_HOST is required when MAIL_TRANSPORT=smtp', path: ['SMTP_HOST'] });
    if (!data.SMTP_PORT) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'SMTP_PORT is required when MAIL_TRANSPORT=smtp', path: ['SMTP_PORT'] });
    if (!data.SMTP_USER) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'SMTP_USER is required when MAIL_TRANSPORT=smtp', path: ['SMTP_USER'] });
    if (!data.SMTP_PASS) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'SMTP_PASS is required when MAIL_TRANSPORT=smtp', path: ['SMTP_PASS'] });
  }
});

const result = refinedSchema.safeParse(process.env);

if (!result.success) {
  const issues = result.error.issues
    .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  console.error(`\n❌ Invalid environment configuration:\n${issues}\n`);
  console.error('Copy server/.env.example to server/.env and fill in the required values.\n');
  process.exit(1);
}

export const env = result.data;
