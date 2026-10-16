import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config';
import { logger } from '../../logger';
import { encryptField, decryptField } from '../crypto/field-encryption';
import type { Database } from '../db';
import type { JobHandler } from '../jobs';
import { PermanentJobError } from '../jobs';

/**
 * Transactional email.
 *
 *  - Callers enqueue a `mail.send` job INSIDE their transaction (so a signup that rolls back sends no email, and an
 *    SMTP outage never fails the signup). The worker delivers with retries.
 *  - One-time secrets (verification / reset tokens) are stored encrypted in the job payload (AAD-bound to the
 *    recipient) and decrypted only inside the worker at send time.
 *  - Transports: SMTP (production / Mailpit in dev), console (dev without SMTP), memory (tests).
 */
export interface OutgoingMail {
  /** Shown as the sender name (the client's name); the address stays ours so the mail is authenticated. */
  fromName?: string;
  /** Where replies go (the person who wrote it). */
  replyTo?: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface MailTransport {
  readonly name: string;
  send(mail: OutgoingMail): Promise<{ messageId?: string }>;
}

/**
 * Exactly one plain address. Anything a mail library could re-interpret (display names, groups, comments, several addresses,
 * line breaks) is refused, so a malformed value can never be turned into a different recipient.
 */
const PLAIN_ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
export function assertPlainAddress(to: string): void {
  if (to.length > 254 || !PLAIN_ADDRESS.test(to)) throw new Error('Refusing to send: recipient is not a single plain e-mail address');
}

export interface SmtpOptions {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
  from?: string;
}

/** Exported so the delivery path can be tested against a local SMTP listener (see mail-smtp.test.ts). Defaults come from configuration. */
export class SmtpTransport implements MailTransport {
  readonly name = 'smtp';
  private from: string;
  private tx: Transporter;
  constructor(o: SmtpOptions = {}) {
    const port = o.port ?? config.SMTP_PORT ?? 587;
    const user = o.user ?? config.SMTP_USER;
    this.from = o.from ?? config.MAIL_FROM;
    this.tx = nodemailer.createTransport({
      host: o.host ?? config.SMTP_HOST,
      port,
      secure: o.secure ?? config.SMTP_SECURE ?? port === 465,
      auth: user ? { user, pass: o.pass ?? config.SMTP_PASS } : undefined,
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 15000,
      pool: true,
      maxConnections: 3,
    });
  }
  async send(mail: OutgoingMail) {
    assertPlainAddress(mail.to);
    if (mail.replyTo) assertPlainAddress(mail.replyTo);
    // A display name can never carry line breaks, quotes or angle brackets: it is the one free-text part of the From header.
    const name = mail.fromName?.replace(/[\r\n"<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    const addr = /<([^>]+)>/.exec(this.from)?.[1] ?? this.from;
    const info = await this.tx.sendMail({ from: name ? { name, address: addr } : this.from, replyTo: mail.replyTo, to: mail.to, subject: mail.subject, html: mail.html, text: mail.text });
    return { messageId: info.messageId };
  }
  close() {
    this.tx.close();
  }
}

class ConsoleTransport implements MailTransport {
  readonly name = 'console';
  async send(mail: OutgoingMail) {
    // Development convenience only (never selected in production: config requires SMTP there).
    logger.info(`[mail:dev] to=${mail.to} subject="${mail.subject}"\n${mail.text}`);
    return {};
  }
}

export class MemoryTransport implements MailTransport {
  readonly name = 'memory';
  readonly sent: OutgoingMail[] = [];
  async send(mail: OutgoingMail) {
    this.sent.push(mail);
    return { messageId: `mem-${this.sent.length}` };
  }
  clear() {
    this.sent.length = 0;
  }
  /** Extract the first `token=` value from the latest mail to `to` whose subject contains `subjectPart`. */
  tokenFor(to: string, subjectPart = ''): string | undefined {
    const m = [...this.sent].reverse().find((x) => x.to.toLowerCase() === to.toLowerCase() && x.subject.includes(subjectPart));
    return m ? /[?&]token=([A-Za-z0-9_-]+)/.exec(m.text)?.[1] : undefined;
  }
}

export const memoryTransport = new MemoryTransport();

let transport: MailTransport | undefined;
export function getTransport(): MailTransport {
  if (transport) return transport;
  transport = config.isTest ? memoryTransport : config.SMTP_HOST ? new SmtpTransport() : new ConsoleTransport();
  return transport;
}
export function setTransportForTests(t: MailTransport | undefined) {
  transport = t;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type MailTemplate = 'verify_email' | 'password_reset' | 'password_changed' | 'account_exists' | 'invitation';

interface TemplateData {
  name?: string;
  tenantName?: string;
  inviterName?: string;
  role?: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function layout(title: string, bodyHtml: string, cta?: { label: string; url: string }) {
  const button = cta
    ? `<p style="margin:28px 0"><a href="${esc(cta.url)}" style="background:#1f6f5c;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">${esc(cta.label)}</a></p>
       <p style="color:#6b6b66;font-size:13px">If the button doesn’t work, paste this link into your browser:<br><span style="word-break:break-all">${esc(cta.url)}</span></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f6f5f0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1c1c1a">
  <div style="max-width:520px;margin:32px auto;background:#fff;border:1px solid #e6e4dc;border-radius:12px;padding:32px">
    <h1 style="font-size:20px;margin:0 0 16px">${esc(title)}</h1>${bodyHtml}${button}
    <hr style="border:none;border-top:1px solid #eceae3;margin:28px 0 12px"><p style="color:#8a8a84;font-size:12px;margin:0">Anibros CRM</p>
  </div></body></html>`;
}

export function renderMail(template: MailTemplate, to: string, data: TemplateData, token?: string): OutgoingMail {
  const base = config.publicAppUrl.replace(/\/$/, '');
  const hello = data.name ? `Hi ${esc(data.name)},` : 'Hi,';
  switch (template) {
    case 'verify_email': {
      const url = `${base}/verify-email?token=${token}`;
      return {
        to,
        subject: 'Verify your email — Anibros CRM',
        html: layout('Confirm your email address', `<p>${hello}</p><p>Welcome to Anibros CRM. Confirm your email to activate your workspace. This link expires in 24 hours.</p>`, { label: 'Verify email', url }),
        text: `${data.name ? `Hi ${data.name},\n\n` : ''}Confirm your email to activate your Anibros CRM workspace (link valid 24 hours):\n${url}\n`,
      };
    }
    case 'password_reset': {
      const url = `${base}/reset-password?token=${token}`;
      return {
        to,
        subject: 'Reset your password — Anibros CRM',
        html: layout('Reset your password', `<p>${hello}</p><p>We received a request to reset your password. This link expires in 1 hour. If you didn’t ask for this, you can ignore this email — your password will not change.</p>`, { label: 'Choose a new password', url }),
        text: `Reset your Anibros CRM password (link valid 1 hour). If you didn't request this, ignore this email.\n${url}\n`,
      };
    }
    case 'password_changed':
      return {
        to,
        subject: 'Your password was changed — Anibros CRM',
        html: layout('Password changed', `<p>${hello}</p><p>The password for your Anibros CRM account was just changed and all other sessions were signed out. If this wasn’t you, reset your password immediately and contact your workspace admin.</p>`),
        text: `The password for your Anibros CRM account was just changed and other sessions were signed out. If this wasn't you, reset it immediately.\n`,
      };
    case 'account_exists': {
      const url = `${base}/forgot-password`;
      return {
        to,
        subject: 'You already have an Anibros CRM account',
        html: layout('You already have an account', `<p>${hello}</p><p>Someone (hopefully you) tried to sign up with this email address, but an account already exists. You can sign in, or reset your password if you’ve forgotten it.</p>`, { label: 'Reset password', url }),
        text: `An Anibros CRM account already exists for this email. Sign in, or reset your password: ${url}\n`,
      };
    }
    case 'invitation': {
      const url = `${base}/accept-invite?token=${token}`;
      return {
        to,
        subject: `${data.inviterName ?? 'A teammate'} invited you to ${data.tenantName ?? 'a workspace'} on Anibros CRM`,
        html: layout(`Join ${data.tenantName ?? 'the workspace'}`, `<p>${hello}</p><p>${esc(data.inviterName ?? 'A teammate')} invited you to join <strong>${esc(data.tenantName ?? 'a workspace')}</strong> as <strong>${esc((data.role ?? 'member').replace(/_/g, ' '))}</strong>. The invitation expires in 7 days.</p>`, { label: 'Accept invitation', url }),
        text: `${data.inviterName ?? 'A teammate'} invited you to ${data.tenantName ?? 'a workspace'} on Anibros CRM (valid 7 days):\n${url}\n`,
      };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Enqueue + worker handler
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface MailJobPayload {
  template: MailTemplate;
  to: string;
  data: TemplateData;
  /** encrypted one-time token (verification / reset / invitation) */
  tokenEnc?: string;
}

/** Queue an email from inside a transaction (uses the narrow SECURITY DEFINER `app.enqueue_mail`). */
export async function enqueueMail(
  tx: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  mail: { template: MailTemplate; to: string; data?: TemplateData; token?: string; dedupeKey?: string }
): Promise<void> {
  const payload: MailJobPayload = {
    template: mail.template,
    to: mail.to.toLowerCase(),
    data: mail.data ?? {},
    ...(mail.token ? { tokenEnc: encryptField(mail.token, `mail:${mail.to.toLowerCase()}`) } : {}),
  };
  await tx.query(`SELECT app.enqueue_mail($1::jsonb, $2)`, [JSON.stringify(payload), mail.dedupeKey ?? null]);
}

export const mailSendHandler: JobHandler = async (job) => {
  const p = job.payload as MailJobPayload;
  if (!p?.to || !p.template) throw new PermanentJobError('Malformed mail job');
  let token: string | undefined;
  if (p.tokenEnc) {
    try {
      token = decryptField(p.tokenEnc, `mail:${p.to}`);
    } catch {
      throw new PermanentJobError('Mail token failed authentication');
    }
  }
  const mail = renderMail(p.template, p.to, p.data ?? {}, token);
  const res = await getTransport().send(mail);
  return { messageId: res.messageId, transport: getTransport().name };
};

export function mailStatus(): { transport: string; external: boolean } {
  const t = getTransport();
  return { transport: t.name, external: t.name === 'smtp' };
}

export type { Database };
