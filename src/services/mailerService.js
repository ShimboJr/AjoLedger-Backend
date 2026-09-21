/**
 * mailerService.js — email delivery service.
 * Supports MAIL_TRANSPORT=smtp (nodemailer) and MAIL_TRANSPORT=console (dev fallback).
 * Full implementation on Day 4/5.
 */
import { env } from '../config/env.js';
import { brand } from '../config/brand.js';

/**
 * sendMail({ to, subject, text, html }) — send an email.
 * In console mode, logs the email to stdout.
 * In smtp mode, sends via nodemailer (Day 4).
 */
export async function sendMail({ to, subject, text, html }) {
  if (env.MAIL_TRANSPORT === 'console') {
    console.log(`[mailer:console] To: ${to} | Subject: ${subject}\n${text ?? ''}`);
    return { messageId: 'console', skipped: true };
  }

  // SMTP path — implemented Day 4
  throw new Error('SMTP mailer not yet implemented — set MAIL_TRANSPORT=console for now');
}

/**
 * Convenience wrapper for notification emails.
 */
export async function sendNotificationEmail({ to, title, body }) {
  return sendMail({
    to,
    subject: `${brand.name}: ${title}`,
    text: `${title}\n\n${body}\n\n-- ${brand.name}`,
    html: `<p>${body}</p><p>— ${brand.name}</p>`,
  });
}
