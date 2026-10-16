import type pg from 'pg';
import type { Database } from '../../platform/db';
import { assertCan, type Actor } from '../../platform/authz/actor';
import { Errors } from '../../platform/errors';
import { audit } from '../../platform/audit';
import { enqueue, PermanentJobError, type JobHandler } from '../../platform/jobs';
import { notify } from '../../platform/notifications';
import { encryptField, decryptField } from '../../platform/crypto/field-encryption';
import { getTransport } from '../../platform/mail';
import type { LeadsService } from '../leads/service';
import { WhatsAppError, checkWhatsAppAccount, sendWhatsApp } from './whatsapp';

/**
 * Sending an e-mail or a WhatsApp message to a lead from inside the CRM.
 *
 *   - It is an ordinary logged activity (so it shows on the timeline, stops the first-reply clock and counts in the reports) PLUS a send job
 *     created in the same transaction: the record and its send exist together or not at all.
 *   - The address or number always comes from the lead's contact, never from the request: the CRM cannot be used to mail arbitrary people.
 *   - Who may send follows who may log that kind of work: a WhatsApp-only specialist can send WhatsApp, not e-mail.
 *   - Delivery state lives on the activity (`metadata.delivery`: queued, sent, failed) and a failure tells the sender.
 */
export interface SendInput {
  channel: 'email' | 'whatsapp';
  subject?: string;
  body: string;
  template?: { name: string; language: string; params?: string[] };
}

const SEND_LIMIT_PER_10_MIN = 40;
const aad = (tenantId: string) => `messaging:${tenantId}:whatsapp`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface WhatsAppAccountDto {
  connected: boolean;
  phoneNumberId: string | null;
  displayPhone: string | null;
  tokenHint: string | null;
  status: 'active' | 'paused' | null;
  lastError: string | null;
  lastSentAt: string | null;
}

export class MessagingService {
  constructor(private db: Database, private leads: LeadsService) {}

  // ── the client's WhatsApp number ─────────────────────────────────────────────────────────────────────────

  async whatsapp(actor: Actor): Promise<WhatsAppAccountDto> {
    assertCan(actor, 'integrations:read');
    return this.db.readTenant(actor, async (tx) => {
      const r = (await tx.query(`SELECT phone_number_id AS "phoneNumberId", display_phone AS "displayPhone", token_hint AS "tokenHint", status, last_error AS "lastError", last_sent_at AS "lastSentAt" FROM messaging_accounts WHERE tenant_id = $1 AND channel = 'whatsapp'`, [actor.tenantId])).rows[0];
      return r ? { connected: true, ...r } : { connected: false, phoneNumberId: null, displayPhone: null, tokenHint: null, status: null, lastError: null, lastSentAt: null };
    });
  }

  async connectWhatsapp(actor: Actor, input: { phoneNumberId: string; accessToken: string }): Promise<WhatsAppAccountDto> {
    assertCan(actor, 'integrations:manage');
    let displayPhone: string | null;
    try {
      displayPhone = (await checkWhatsAppAccount(input.phoneNumberId, input.accessToken)).displayPhone;
    } catch (e) {
      if (e instanceof WhatsAppError) throw Errors.validation([{ path: 'body.accessToken', message: e.message }]);
      throw e;
    }
    await this.db.withTenant(actor, async (tx) => {
      await tx.query(
        `INSERT INTO messaging_accounts (tenant_id, channel, phone_number_id, display_phone, token_enc, token_hint, created_by) VALUES ($1,'whatsapp',$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, channel) DO UPDATE SET phone_number_id = EXCLUDED.phone_number_id, display_phone = EXCLUDED.display_phone, token_enc = EXCLUDED.token_enc, token_hint = EXCLUDED.token_hint, status = 'active', last_error = NULL`,
        [actor.tenantId, input.phoneNumberId, displayPhone, encryptField(input.accessToken, aad(actor.tenantId)), input.accessToken.slice(-4), actor.userId]
      );
      await audit(tx, { action: 'messaging.whatsapp_connect', entityType: 'messaging_account', entityId: actor.tenantId, after: { phoneNumberId: input.phoneNumberId } });
    });
    return this.whatsapp(actor);
  }

  async disconnectWhatsapp(actor: Actor): Promise<void> {
    assertCan(actor, 'integrations:delete');
    await this.db.withTenant(actor, async (tx) => {
      await tx.query(`DELETE FROM messaging_accounts WHERE tenant_id = $1 AND channel = 'whatsapp'`, [actor.tenantId]);
      await audit(tx, { action: 'messaging.whatsapp_disconnect', entityType: 'messaging_account', entityId: actor.tenantId });
    });
  }

  // ── sending ──────────────────────────────────────────────────────────────────────────────────────────────

  async send(actor: Actor, leadId: string, input: SendInput): Promise<{ activityId: string; delivery: 'queued' }> {
    const body = input.body.trim();
    const problems: Array<{ path: string; message: string }> = [];
    if (!body && !(input.channel === 'whatsapp' && input.template)) problems.push({ path: 'body.body', message: 'Write a message' });
    if (input.channel === 'email' && !input.subject?.trim()) problems.push({ path: 'body.subject', message: 'Add a subject' });
    if (input.channel === 'email' && input.template) problems.push({ path: 'body.template', message: 'Templates are for WhatsApp only' });
    if (problems.length) throw Errors.validation(problems);

    // A person cannot flood leads (or the mail server) from here: a generous but finite number of messages per ten minutes.
    const recent = await this.db.readTenant(actor, async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM activities WHERE tenant_id = $1 AND user_id = $2 AND metadata ? 'delivery' AND created_at > now() - interval '10 minutes'`, [actor.tenantId, actor.userId])).rows[0].n as number);
    if (recent >= SEND_LIMIT_PER_10_MIN) throw Errors.rateLimited(120, 'You have sent a lot of messages in the last few minutes. Wait a little before sending more.');

    const act = await this.leads.logActivity(
      actor,
      leadId,
      { type: input.channel, description: input.channel === 'email' ? `Subject: ${input.subject!.trim()}\n\n${body}` : body || `Template “${input.template!.name}”`, direction: 'outbound' },
      {
        metadata: { delivery: 'queued', channel: input.channel, ...(input.subject ? { subject: input.subject.trim() } : {}), ...(input.template ? { template: input.template } : {}) },
        after: async (tx, activity) => {
          const c = (await tx.query(`SELECT c.email::text AS email, c.phone FROM leads l LEFT JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = l.tenant_id WHERE l.id = $1 AND l.tenant_id = $2`, [leadId, actor.tenantId])).rows[0];
          if (input.channel === 'email' && !c?.email) throw Errors.validation([{ path: 'leadId', message: 'This lead has no e-mail address. Add one first.' }]);
          // Someone who withdrew their agreement for this channel (and has not agreed again) is not messaged from here. Never having been
          // asked is fine: they enquired, and replying is what they expect.
          const optedOut = await tx.query(
            `SELECT 1 FROM leads l JOIN communication_consents cc ON cc.contact_id = l.contact_id AND cc.tenant_id = l.tenant_id
              WHERE l.id = $1 AND l.tenant_id = $2 AND cc.channel = $3::consent_channel AND cc.status = 'revoked'
                AND NOT EXISTS (SELECT 1 FROM communication_consents g WHERE g.contact_id = cc.contact_id AND g.tenant_id = cc.tenant_id AND g.channel = cc.channel AND g.status = 'granted')
              LIMIT 1`,
            [leadId, actor.tenantId, input.channel]
          );
          if (optedOut.rowCount) throw Errors.conflict(`This person has opted out of ${input.channel === 'email' ? 'e-mail' : 'WhatsApp'} messages. If they agreed again, switch it back on in their contact first.`);
          if (input.channel === 'whatsapp') {
            if (!c?.phone) throw Errors.validation([{ path: 'leadId', message: 'This lead has no phone number. Add one first.' }]);
            const acct = (await tx.query(`SELECT status FROM messaging_accounts WHERE tenant_id = $1 AND channel = 'whatsapp'`, [actor.tenantId])).rows[0];
            if (!acct || acct.status !== 'active') throw Errors.conflict('WhatsApp is not connected for this client. Connect its WhatsApp Business number in Settings → Lead sources, or open WhatsApp from the lead to message by hand.');
          }
          await enqueue(tx, { type: 'message.send', payload: { activityId: activity.id }, dedupeKey: `msg:${activity.id}`, maxAttempts: 6 });
        },
      }
    );
    return { activityId: act.id, delivery: 'queued' };
  }
}

// ── worker ──────────────────────────────────────────────────────────────────────────────────────────────

type Row = { id: string; lead_id: string; type: 'email' | 'whatsapp'; description: string; metadata: Record<string, any>; user_id: string | null; email: string | null; phone: string | null; tenant_name: string; sender_email: string | null };

async function markFailed(tx: pg.PoolClient, tenantId: string, row: Row, reason: string) {
  await tx.query(`UPDATE activities SET metadata = metadata || $2::jsonb WHERE id = $1 AND tenant_id = $3`, [row.id, JSON.stringify({ delivery: 'failed', error: reason }), tenantId]);
  if (row.user_id) await notify(tx, { userId: row.user_id, title: `Your ${row.type === 'email' ? 'e-mail' : 'WhatsApp message'} was not delivered`, message: reason.slice(0, 200), type: 'lead_activity', link: `/leads/${row.lead_id}`, entityType: 'lead', entityId: row.lead_id, dedupeKey: `msg-failed:${row.id}` });
}

export const messageSendHandler: JobHandler = async (job, ctx) => {
  const tenantId = job.tenantId;
  const activityId = String(job.payload.activityId ?? '');
  if (!tenantId || !activityId) throw new PermanentJobError('Malformed message job');

  const loaded = await ctx.withTenant(async (tx) => {
    const row = (
      await tx.query(
        `SELECT a.id, a.lead_id, a.type::text AS type, a.description, a.metadata, a.user_id, c.email::text AS email, c.phone, t.name AS tenant_name, u.email::text AS sender_email
           FROM activities a JOIN leads l ON l.id = a.lead_id AND l.tenant_id = a.tenant_id LEFT JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = l.tenant_id
           JOIN tenants t ON t.id = a.tenant_id LEFT JOIN users u ON u.id = a.user_id
          WHERE a.id = $1 AND a.tenant_id = $2`,
        [activityId, tenantId]
      )
    ).rows[0] as Row | undefined;
    if (!row) throw new PermanentJobError('Message not found');
    if (row.metadata?.delivery !== 'queued') return { skip: String(row.metadata?.delivery ?? 'unknown') };
    let token: { phoneNumberId: string; token: string } | null = null;
    if (row.type === 'whatsapp') {
      const a = (await tx.query(`SELECT phone_number_id, token_enc, status FROM messaging_accounts WHERE tenant_id = $1 AND channel = 'whatsapp'`, [tenantId])).rows[0];
      if (!a || a.status !== 'active') {
        await markFailed(tx, tenantId, row, 'WhatsApp is no longer connected for this client.');
        return { skip: 'whatsapp not connected' };
      }
      token = { phoneNumberId: a.phone_number_id as string, token: decryptField(a.token_enc as string, aad(tenantId)) };
    }
    return { row, token };
  });
  if ('skip' in loaded) return { skipped: loaded.skip };
  const { row, token } = loaded;

  try {
    let providerId: string | undefined;
    if (row.type === 'email') {
      const subject = String(row.metadata.subject ?? '');
      const text = row.description.replace(/^Subject: .*\n\n/, '');
      const res = await getTransport().send({
        to: row.email ?? '',
        fromName: row.tenant_name,
        replyTo: row.sender_email ?? undefined,
        subject,
        text: `${text}\n\n--\nSent on behalf of ${row.tenant_name}`,
        html: `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1c1c1a">${esc(text).replace(/\n/g, '<br>')}<p style="color:#8a8a84;font-size:12px;margin-top:24px">Sent on behalf of ${esc(row.tenant_name)}</p></div>`,
      });
      providerId = res.messageId;
    } else {
      const res = await sendWhatsApp({ phoneNumberId: token!.phoneNumberId, token: token!.token, to: row.phone ?? '', text: row.metadata.template ? undefined : row.description, template: row.metadata.template });
      providerId = res.messageId;
    }
    await ctx.withTenant(async (tx) => {
      await tx.query(`UPDATE activities SET metadata = metadata || $2::jsonb WHERE id = $1 AND tenant_id = $3`, [row.id, JSON.stringify({ delivery: 'sent', sentAt: new Date().toISOString(), providerId }), tenantId]);
      if (row.type === 'whatsapp') await tx.query(`UPDATE messaging_accounts SET last_sent_at = now(), last_error = NULL WHERE tenant_id = $1 AND channel = 'whatsapp'`, [tenantId]);
    });
    return { sent: true };
  } catch (e) {
    const permanent = e instanceof WhatsAppError ? e.permanent : /plain e-mail address/.test(String((e as Error)?.message));
    const reason = e instanceof WhatsAppError ? e.message : permanent ? 'That e-mail address is not valid.' : 'The mail server did not accept the message.';
    if (permanent || job.attempts >= job.maxAttempts) {
      await ctx.withTenant(async (tx) => {
        await markFailed(tx, tenantId, row, reason);
        if (row.type === 'whatsapp') await tx.query(`UPDATE messaging_accounts SET last_error = $2 WHERE tenant_id = $1 AND channel = 'whatsapp'`, [tenantId, reason.slice(0, 300)]);
      });
      return { failed: reason };
    }
    throw e; // transient: the job runner retries with back-off
  }
};
