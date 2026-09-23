/**
 * mailerService.js — email delivery service.
 *
 * MAIL_TRANSPORT=console  → logs subject + recipient only (no body — no secrets in logs).
 * MAIL_TRANSPORT=smtp     → sends via nodemailer; secure:true on port 465, STARTTLS otherwise.
 *
 * sendMail({ to, subject, text, html }) — never throws into callers.
 *   Returns { status: 'sent'|'failed'|'skipped', messageId? }.
 *
 * sendCircleMail({ to, subject, title, body, circleName, amountKobo, dueDate, circleId })
 *   Builds a responsive HTML + plain-text email using the standard template.
 *   All user-supplied strings are HTML-escaped.
 */

import nodemailer from 'nodemailer';
import { env }    from '../config/env.js';
import { brand }  from '../config/brand.js';

// ── HTML escaping ─────────────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

// ── Date formatter (Africa/Lagos) ─────────────────────────────────────────────

const lagosFormatter = new Intl.DateTimeFormat('en-NG', {
  timeZone: 'Africa/Lagos',
  year:     'numeric',
  month:    'long',
  day:      'numeric',
  hour:     '2-digit',
  minute:   '2-digit',
});

function formatLagos(date) {
  if (!date) return '—';
  try   { return lagosFormatter.format(new Date(date)); }
  catch { return String(date); }
}

// ── Naira formatter ───────────────────────────────────────────────────────────

function formatNaira(kobo) {
  if (kobo == null) return null;
  return `₦${(kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── SMTP transporter (lazy singleton) ────────────────────────────────────────

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;
  const port = env.SMTP_PORT ?? 587;
  _transporter = nodemailer.createTransport({
    host:   env.SMTP_HOST,
    port,
    secure: port === 465,
    auth:   { user: env.SMTP_USER, pass: env.SMTP_PASS },
    // Fail fast if SMTP port is blocked (e.g. Render free tier blocks outbound port 587).
    // Without these, nodemailer hangs for 30-60 s per attempt with no error.
    connectionTimeout: 5_000,   // ms to wait for TCP connection
    greetingTimeout:   5_000,   // ms to wait for SMTP EHLO greeting after connect
    socketTimeout:     10_000,  // ms of inactivity before killing an established socket
  });
  return _transporter;
}

// ── HTML email template ───────────────────────────────────────────────────────

/**
 * buildTemplate({ title, body, circleName?, amountKobo?, dueDate?, circleUrl? })
 * Returns { html, text }.  All user-supplied values are escaped.
 */
function buildTemplate({ title, body, circleName, amountKobo, dueDate, circleUrl }) {
  const amountDisplay = formatNaira(amountKobo);
  const dueDateStr    = dueDate ? formatLagos(dueDate) : null;

  // ── HTML ──────────────────────────────────────────────────────────────────
  const rows = [
    circleName    ? `<tr><td style="padding:4px 0;color:#475569;"><strong>Circle:</strong> ${esc(circleName)}</td></tr>` : '',
    amountDisplay ? `<tr><td style="padding:4px 0;color:#475569;"><strong>Amount:</strong> ${esc(amountDisplay)}</td></tr>` : '',
    dueDateStr    ? `<tr><td style="padding:4px 0;color:#475569;"><strong>Due date:</strong> ${esc(dueDateStr)}</td></tr>` : '',
  ].filter(Boolean).join('');

  const ctaButton = circleUrl
    ? `<div style="margin-top:24px;"><a href="${esc(circleUrl)}" style="display:inline-block;background:#0f4c81;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">View Circle →</a></div>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
</head>
<body style="font-family:system-ui,sans-serif;background:#f8fafc;margin:0;padding:16px;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,0.07);">
    <h2 style="margin:0 0 4px;color:#0f4c81;font-size:20px;font-weight:700;">${esc(brand.name)}</h2>
    <p style="margin:0 0 20px;color:#64748b;font-size:12px;">Save together. Provably.</p>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 20px;">
    <h3 style="margin:0 0 12px;color:#1e293b;font-size:18px;font-weight:600;">${esc(title)}</h3>
    <p style="color:#475569;line-height:1.6;margin:0 0 16px;">${esc(body)}</p>
    ${rows ? `<table style="border-collapse:collapse;width:100%;margin-bottom:8px;">${rows}</table>` : ''}
    ${ctaButton}
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 16px;">
    <p style="color:#94a3b8;font-size:11px;margin:0;line-height:1.5;">
      You received this because you are a member of an AjoLedger savings circle.
      This is a <strong>sandbox</strong> environment — no real money moves.
    </p>
  </div>
</body>
</html>`;

  // ── Plain text ────────────────────────────────────────────────────────────
  const textLines = [
    brand.name,
    '='.repeat(brand.name.length),
    '',
    title,
    '',
    body,
    '',
    ...(circleName    ? [`Circle:   ${circleName}`]   : []),
    ...(amountDisplay ? [`Amount:   ${amountDisplay}`] : []),
    ...(dueDateStr    ? [`Due date: ${dueDateStr}`]   : []),
    ...(circleUrl     ? ['', `View circle: ${circleUrl}`] : []),
    '',
    `-- ${brand.name} (sandbox environment)`,
  ];

  return { html, text: textLines.join('\n') };
}

// ── sendMail ──────────────────────────────────────────────────────────────────

/**
 * sendMail({ to, subject, text, html })
 * Never throws into callers.
 *
 * @returns {{ status: 'sent'|'failed'|'skipped', messageId?: string }}
 */
export async function sendMail({ to, subject, text, html }) {
  if (!to) return { status: 'skipped' };

  if (env.MAIL_TRANSPORT === 'console') {
    console.log(`[mailer:console] To: ${to} | Subject: ${subject}`);
    return { status: 'sent', messageId: 'console' };
  }

  // SMTP path
  try {
    const transporter = getTransporter();
    const info = await transporter.sendMail({
      from:    env.MAIL_FROM,
      to,
      subject,
      text,
      html,
    });
    return { status: 'sent', messageId: info.messageId };
  } catch (err) {
    // Reset singleton so the next call gets a fresh transport (avoids reusing a dead connection)
    _transporter = null;
    // Log the error but do NOT include SMTP credentials
    console.error(
      `[mailer:smtp] Failed — to: ${to} | subject: ${subject} | error: ${err.message}`
    );
    return { status: 'failed' };
  }
}

// ── sendCircleMail ────────────────────────────────────────────────────────────

/**
 * sendCircleMail — send a circle-context notification using the standard template.
 *
 * @param {{ to: string, subject: string, title: string, body: string,
 *           circleName?: string, amountKobo?: number, dueDate?: Date,
 *           circleId?: string }} params
 */
export async function sendCircleMail({
  to,
  subject,
  title,
  body,
  circleName,
  amountKobo,
  dueDate,
  circleId,
}) {
  const circleUrl = circleId ? `${env.CLIENT_URL}/circles/${circleId}` : null;
  const { html, text } = buildTemplate({ title, body, circleName, amountKobo, dueDate, circleUrl });
  return sendMail({ to, subject: subject || title, text, html });
}

// ── sendNotificationEmail (legacy wrapper — kept for backward compat) ─────────

/**
 * @deprecated Use sendCircleMail for new code.
 */
export async function sendNotificationEmail({ to, title, body }) {
  const { html, text } = buildTemplate({ title, body });
  return sendMail({
    to,
    subject: `${brand.name}: ${title}`,
    text,
    html,
  });
}
