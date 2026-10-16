import type pg from 'pg';
import type { Database } from '../../platform/db';
import { assertCan, assertCanActOn, type Actor } from '../../platform/authz/actor';
import { scopeOf } from '../../platform/authz/matrix';
import { Errors, type FieldIssue } from '../../platform/errors';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/events';
import { buildPage, cursorPredicate, decodeCursor } from '../../platform/http/pagination';
import type { PageInfo } from '../../platform/http/route';
import { escapeLike, normalizeEmail, normalizePhone, normalizeTags } from './normalize';

export type IdentifierKind = 'email' | 'phone';

export interface ContactDto {
  id: string;
  firstName: string;
  lastName: string | null;
  displayName: string;
  email: string | null;
  phone: string | null;
  alternateEmails: string[];
  alternatePhones: string[];
  company: string | null;
  jobTitle: string | null;
  city: string | null;
  ownerId: string | null;
  tags: string[];
  customFields: Record<string, unknown>;
  leadCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ContactInput {
  firstName: string;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  alternateEmails?: string[];
  alternatePhones?: string[];
  company?: string | null;
  jobTitle?: string | null;
  city?: string | null;
  ownerId?: string | null;
  tags?: string[];
  customFields?: Record<string, unknown>;
}

export type ContactPatch = Partial<ContactInput>;

export type ContactSort = 'created' | 'updated' | 'name';

export interface ContactListQuery {
  limit: number;
  cursor?: string;
  q?: string;
  ownerId?: string;
  tag?: string;
  sort: ContactSort;
  order: 'asc' | 'desc';
}

const MERGE_UNDO_WINDOW_DAYS = 30;
const MAX_MERGE_BATCH = 5;

const COLUMNS = `
  c.id, c.first_name AS "firstName", c.last_name AS "lastName", c.display_name AS "displayName",
  c.email::text AS email, c.phone, c.company, c.job_title AS "jobTitle", c.city, c.owner_id AS "ownerId",
  c.tags, c.custom_fields AS "customFields", c.version, c.created_at AS "createdAt", c.updated_at AS "updatedAt",
  c.created_at::text AS "_created", c.updated_at::text AS "_updated",
  COALESCE((SELECT array_agg(i.value ORDER BY i.created_at, i.id) FROM contact_identifiers i
             WHERE i.contact_id = c.id AND i.kind = 'email' AND NOT i.is_primary AND i.released_at IS NULL), '{}') AS "alternateEmails",
  COALESCE((SELECT array_agg(i.value ORDER BY i.created_at, i.id) FROM contact_identifiers i
             WHERE i.contact_id = c.id AND i.kind = 'phone' AND NOT i.is_primary AND i.released_at IS NULL), '{}') AS "alternatePhones",
  (SELECT count(*)::int FROM leads l WHERE l.contact_id = c.id AND l.tenant_id = c.tenant_id AND l.deleted_at IS NULL) AS "leadCount"`;

interface Ident {
  kind: IdentifierKind;
  value: string;
  primary: boolean;
}

export interface DuplicateHit {
  id: string;
  displayName: string;
  matchedOn: IdentifierKind[];
}

export class ContactsService {
  constructor(private db: Database) {}

  // ── reads ───────────────────────────────────────────────────────────────────────────────────────────

  async list(actor: Actor, q: ContactListQuery): Promise<{ items: ContactDto[]; page: PageInfo }> {
    assertCan(actor, 'contacts:read');
    const sortSig = `contacts:${q.sort}:${q.order}`;
    const cursor = decodeCursor(q.cursor, sortSig);
    const params: unknown[] = [actor.tenantId];
    const where: string[] = ['c.tenant_id = $1', 'c.deleted_at IS NULL'];

    if (q.ownerId) {
      params.push(q.ownerId);
      where.push(`c.owner_id = $${params.length}`);
    }
    if (q.tag) {
      params.push(normalizeTags([q.tag]));
      where.push(`c.tags @> $${params.length}::text[]`);
    }
    if (q.q?.trim()) {
      const term = q.q.trim().slice(0, 100);
      params.push(`%${escapeLike(term)}%`);
      const like = `$${params.length}`;
      const parts = [
        `c.display_name ILIKE ${like}`,
        `c.company ILIKE ${like}`,
        `EXISTS (SELECT 1 FROM contact_identifiers i WHERE i.contact_id = c.id AND i.released_at IS NULL AND i.value ILIKE ${like})`,
      ];
      const digits = term.replace(/\D/g, '');
      if (digits.length >= 3) {
        params.push(`%${digits}%`);
        parts.push(`EXISTS (SELECT 1 FROM contact_identifiers i WHERE i.contact_id = c.id AND i.kind = 'phone' AND i.released_at IS NULL AND i.value LIKE $${params.length})`);
      }
      where.push(`(${parts.join(' OR ')})`);
    }

    const key = { created: 'c.created_at', updated: 'c.updated_at', name: 'c.display_name' }[q.sort];
    const cast = q.sort === 'name' ? '' : '::timestamptz';
    const pred = cursorPredicate(cursor, params, key, 'c.id', q.order, cast);
    if (pred) where.push(pred);
    params.push(q.limit + 1);

    return this.db.readTenant(actor, async (tx) => {
      const { rows } = await tx.query(
        `SELECT ${COLUMNS} FROM contacts c WHERE ${where.join(' AND ')}
          ORDER BY ${key} ${q.order}, c.id ${q.order} LIMIT $${params.length}`,
        params
      );
      // Cursor keys come from ::text columns so microsecond precision survives the round trip (JS Dates only keep ms).
      const { items, page } = buildPage(rows as Array<ContactDto & { _created: string; _updated: string }>, q.limit, sortSig, (r) =>
        q.sort === 'created' ? r._created : q.sort === 'updated' ? r._updated : r.displayName
      );
      return { items: items.map(({ _created, _updated, ...dto }) => dto as ContactDto), page };
    });
  }

  async get(actor: Actor, id: string): Promise<ContactDto> {
    assertCan(actor, 'contacts:read');
    return this.db.readTenant(actor, async (tx) => {
      const c = await this.fetch(tx, actor.tenantId, id);
      if (!c) throw Errors.notFound('Contact');
      return c;
    });
  }

  /** Who already uses these identifiers? Used by the UI while typing and by integrations to upsert. */
  async lookup(actor: Actor, input: { email?: string; phone?: string }): Promise<DuplicateHit[]> {
    assertCan(actor, 'contacts:read');
    return this.db.readTenant(actor, async (tx) => {
      const country = await this.defaultCountry(tx, actor.tenantId);
      const idents: Ident[] = [];
      if (input.email) {
        const e = normalizeEmail(input.email);
        if (e) idents.push({ kind: 'email', value: e, primary: false });
      }
      if (input.phone) {
        const p = normalizePhone(input.phone, country);
        if (p) idents.push({ kind: 'phone', value: p, primary: false });
      }
      return this.findDuplicates(tx, actor.tenantId, idents);
    });
  }

  // ── writes ──────────────────────────────────────────────────────────────────────────────────────────

  async create(actor: Actor, input: ContactInput): Promise<ContactDto> {
    assertCan(actor, 'contacts:create');
    return this.db.withTenant(actor, async (tx) => {
      const country = await this.defaultCountry(tx, actor.tenantId);
      const issues: FieldIssue[] = [];
      const email = this.parseOptional(input.email, 'email', (v) => normalizeEmail(v), 'Enter a valid email address', issues);
      const phone = this.parseOptional(input.phone, 'phone', (v) => normalizePhone(v, country), 'Enter a valid phone number (include the country code if it is not local)', issues);
      const altEmails = this.parseMany(input.alternateEmails, 'alternateEmails', (v) => normalizeEmail(v), 'Enter a valid email address', issues);
      const altPhones = this.parseMany(input.alternatePhones, 'alternatePhones', (v) => normalizePhone(v, country), 'Enter a valid phone number', issues);
      if (issues.length) throw Errors.validation(issues);
      const idents = this.composeIdentifiers(email, altEmails, phone, altPhones);

      const ownerId = await this.resolveOwner(tx, actor, input.ownerId, actor.userId);
      await this.assertNoDuplicates(tx, actor.tenantId, idents);

      const ins = await tx.query(
        `INSERT INTO contacts (tenant_id, first_name, last_name, email, phone, company, job_title, city, owner_id, created_by, tags, custom_fields)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12::jsonb) RETURNING id`,
        [
          actor.tenantId,
          input.firstName.trim(),
          blank(input.lastName),
          email,
          phone,
          blank(input.company),
          blank(input.jobTitle),
          blank(input.city),
          ownerId,
          actor.userId,
          normalizeTags(input.tags),
          JSON.stringify(input.customFields ?? {}),
        ]
      );
      const id = ins.rows[0].id as string;
      await this.insertIdentifiers(tx, actor.tenantId, id, idents);
      const dto = (await this.fetch(tx, actor.tenantId, id))!;
      await audit(tx, { action: 'contact.create', entityType: 'contact', entityId: id, after: dto });
      await emit(tx, { type: 'contact.created', aggregateId: id, payload: { ownerId } });
      return dto;
    });
  }

  async update(actor: Actor, id: string, patch: ContactPatch, expectedVersion?: number): Promise<ContactDto> {
    assertCan(actor, 'contacts:update');
    return this.db.withTenant(actor, async (tx) => {
      const cur = await tx.query(`SELECT id, owner_id, version, email::text AS email, phone FROM contacts WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, actor.tenantId]);
      const row = cur.rows[0];
      if (!row) throw Errors.notFound('Contact');
      assertCanActOn(actor, 'contacts:update', row.owner_id);
      if (expectedVersion !== undefined && expectedVersion !== row.version) throw Errors.preconditionFailed();
      const before = (await this.fetch(tx, actor.tenantId, id))!;

      const sets: string[] = [];
      const params: unknown[] = [id, actor.tenantId];
      const set = (col: string, value: unknown, cast = '') => {
        params.push(value);
        sets.push(`${col} = $${params.length}${cast}`);
      };

      if (patch.firstName !== undefined) set('first_name', patch.firstName.trim());
      if (patch.lastName !== undefined) set('last_name', blank(patch.lastName));
      if (patch.company !== undefined) set('company', blank(patch.company));
      if (patch.jobTitle !== undefined) set('job_title', blank(patch.jobTitle));
      if (patch.city !== undefined) set('city', blank(patch.city));
      if (patch.tags !== undefined) set('tags', normalizeTags(patch.tags), '::text[]');
      if (patch.customFields !== undefined) set('custom_fields', JSON.stringify(patch.customFields), '::jsonb');
      if (patch.ownerId !== undefined) set('owner_id', await this.resolveOwner(tx, actor, patch.ownerId, null));

      const emailTouched = patch.email !== undefined || patch.alternateEmails !== undefined;
      const phoneTouched = patch.phone !== undefined || patch.alternatePhones !== undefined;
      if (emailTouched || phoneTouched) {
        const country = await this.defaultCountry(tx, actor.tenantId);
        const next: Ident[] = [];
        const issues: FieldIssue[] = [];
        if (emailTouched) {
          const primary = patch.email !== undefined ? this.parseOptional(patch.email, 'email', (v) => normalizeEmail(v), 'Enter a valid email address', issues) : before.email;
          const alts = patch.alternateEmails !== undefined ? this.parseMany(patch.alternateEmails, 'alternateEmails', (v) => normalizeEmail(v), 'Enter a valid email address', issues) : before.alternateEmails;
          next.push(...this.composeIdentifiers(primary, alts, null, []));
          set('email', primary);
        }
        if (phoneTouched) {
          const primary = patch.phone !== undefined ? this.parseOptional(patch.phone, 'phone', (v) => normalizePhone(v, country), 'Enter a valid phone number', issues) : before.phone;
          const alts = patch.alternatePhones !== undefined ? this.parseMany(patch.alternatePhones, 'alternatePhones', (v) => normalizePhone(v, country), 'Enter a valid phone number', issues) : before.alternatePhones;
          next.push(...this.composeIdentifiers(null, [], primary, alts));
          set('phone', primary);
        }
        if (issues.length) throw Errors.validation(issues);
        await this.assertNoDuplicates(tx, actor.tenantId, next, id);
        await this.replaceIdentifiers(tx, actor.tenantId, id, next, { email: emailTouched, phone: phoneTouched });
      }

      if (sets.length) await tx.query(`UPDATE contacts SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2`, params);
      else await tx.query(`UPDATE contacts SET updated_at = updated_at WHERE id = $1 AND tenant_id = $2`, [id, actor.tenantId]); // no-op keeps the row locked until COMMIT

      const after = (await this.fetch(tx, actor.tenantId, id))!;
      await audit(tx, { action: 'contact.update', entityType: 'contact', entityId: id, before, after });
      await emit(tx, { type: 'contact.updated', aggregateId: id, payload: { version: after.version } });
      return after;
    });
  }

  async remove(actor: Actor, id: string): Promise<void> {
    assertCan(actor, 'contacts:delete');
    await this.db.withTenant(actor, async (tx) => {
      const before = await this.fetch(tx, actor.tenantId, id);
      if (!before) throw Errors.notFound('Contact');
      await tx.query(`UPDATE contacts SET deleted_at = now() WHERE id = $1 AND tenant_id = $2`, [id, actor.tenantId]);
      await tx.query(`UPDATE contact_identifiers SET released_at = now() WHERE contact_id = $1 AND tenant_id = $2 AND released_at IS NULL`, [id, actor.tenantId]);
      await audit(tx, { action: 'contact.delete', entityType: 'contact', entityId: id, before });
      await emit(tx, { type: 'contact.deleted', aggregateId: id });
    });
  }

  async restore(actor: Actor, id: string): Promise<ContactDto> {
    assertCan(actor, 'contacts:delete');
    return this.db.withTenant(actor, async (tx) => {
      const r = await tx.query(`UPDATE contacts SET deleted_at = NULL WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NOT NULL AND merged_into_id IS NULL RETURNING id`, [id, actor.tenantId]);
      if (!r.rowCount) throw Errors.notFound('Archived contact');
      try {
        await tx.query(`UPDATE contact_identifiers SET released_at = NULL WHERE contact_id = $1 AND tenant_id = $2 AND released_at IS NOT NULL`, [id, actor.tenantId]);
      } catch (e: any) {
        if (e?.code === '23505') throw Errors.conflict('An email or phone number of this contact now belongs to another contact; merge or edit that contact first');
        throw e;
      }
      const dto = (await this.fetch(tx, actor.tenantId, id))!;
      await audit(tx, { action: 'contact.restore', entityType: 'contact', entityId: id, after: dto });
      await emit(tx, { type: 'contact.updated', aggregateId: id, payload: { restored: true } });
      return dto;
    });
  }

  // ── merge / unmerge ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Fold `duplicateIds` into `survivorId`. Blank fields on the survivor are filled from the duplicates (never
   * overwritten), tags are unioned, identifiers / leads / consents are re-parented. A snapshot is stored so the
   * merge can be undone for 30 days.
   */
  async merge(actor: Actor, survivorId: string, duplicateIds: string[]): Promise<{ contact: ContactDto; merges: Array<{ id: string; mergedId: string }> }> {
    assertCan(actor, 'contacts:merge');
    const dupes = [...new Set(duplicateIds)].filter((d) => d !== survivorId);
    if (!dupes.length) throw Errors.badRequest('Choose at least one other contact to merge');
    if (dupes.length > MAX_MERGE_BATCH) throw Errors.badRequest(`Merge at most ${MAX_MERGE_BATCH} contacts at a time`);

    return this.db.withTenant(actor, async (tx) => {
      // Lock in a stable order so two concurrent merges over the same pair cannot deadlock.
      const ids = [survivorId, ...dupes].sort();
      const locked = await tx.query(`SELECT id FROM contacts WHERE id = ANY($1::uuid[]) AND tenant_id = $2 AND deleted_at IS NULL ORDER BY id FOR UPDATE`, [ids, actor.tenantId]);
      if (locked.rowCount !== ids.length) throw Errors.notFound('Contact');

      const survivor = (await this.fetch(tx, actor.tenantId, survivorId))!;
      const merges: Array<{ id: string; mergedId: string }> = [];
      let tags = [...survivor.tags];
      const fill: Partial<Record<'lastName' | 'company' | 'jobTitle' | 'city' | 'ownerId', string | null>> = {};
      const survivorOwner = survivor.ownerId;

      for (const dupId of dupes) {
        const dup = (await this.fetch(tx, actor.tenantId, dupId))!;
        const idents = await tx.query(`SELECT id FROM contact_identifiers WHERE contact_id = $1 AND tenant_id = $2 AND released_at IS NULL`, [dupId, actor.tenantId]);
        const leads = await tx.query(`SELECT id FROM leads WHERE contact_id = $1 AND tenant_id = $2`, [dupId, actor.tenantId]);
        const consents = await tx.query(`SELECT id FROM communication_consents WHERE contact_id = $1 AND tenant_id = $2`, [dupId, actor.tenantId]);

        // Re-parent. Moved identifiers become secondary: the survivor keeps its own primaries.
        await tx.query(`UPDATE contact_identifiers SET contact_id = $1, is_primary = false WHERE contact_id = $2 AND tenant_id = $3 AND released_at IS NULL`, [survivorId, dupId, actor.tenantId]);
        await tx.query(`UPDATE leads SET contact_id = $1 WHERE contact_id = $2 AND tenant_id = $3`, [survivorId, dupId, actor.tenantId]);
        await tx.query(`UPDATE communication_consents SET contact_id = $1 WHERE contact_id = $2 AND tenant_id = $3`, [survivorId, dupId, actor.tenantId]);
        await tx.query(`UPDATE contacts SET deleted_at = now(), merged_into_id = $1, email = NULL, phone = NULL WHERE id = $2 AND tenant_id = $3`, [survivorId, dupId, actor.tenantId]);

        tags = normalizeTags([...tags, ...dup.tags]);
        for (const f of ['lastName', 'company', 'jobTitle', 'city'] as const) if (!survivor[f] && !fill[f] && dup[f]) fill[f] = dup[f];
        if (!survivorOwner && !fill.ownerId && dup.ownerId) fill.ownerId = dup.ownerId;

        const snap = {
          before: { email: dup.email, phone: dup.phone, ownerId: dup.ownerId, tags: dup.tags },
          identifierIds: idents.rows.map((r) => r.id),
          leadIds: leads.rows.map((r) => r.id),
          consentIds: consents.rows.map((r) => r.id),
        };
        const m = await tx.query(`INSERT INTO contact_merges (tenant_id, survivor_id, merged_id, snapshot, merged_by) VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING id`, [actor.tenantId, survivorId, dupId, JSON.stringify(snap), actor.userId]);
        merges.push({ id: m.rows[0].id, mergedId: dupId });
      }

      const sets = ['tags = $3::text[]'];
      const params: unknown[] = [survivorId, actor.tenantId, tags];
      const colOf = { lastName: 'last_name', company: 'company', jobTitle: 'job_title', city: 'city', ownerId: 'owner_id' } as const;
      for (const [k, v] of Object.entries(fill)) {
        params.push(v);
        sets.push(`${colOf[k as keyof typeof colOf]} = $${params.length}`);
      }
      await tx.query(`UPDATE contacts SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2`, params);
      // A survivor without a primary email/phone adopts one of the moved identifiers.
      await this.promotePrimaries(tx, actor.tenantId, survivorId);

      const after = (await this.fetch(tx, actor.tenantId, survivorId))!;
      await audit(tx, { action: 'contact.merge', entityType: 'contact', entityId: survivorId, before: survivor, after: { ...after, mergedIds: dupes } });
      await emit(tx, { type: 'contact.merged', aggregateId: survivorId, payload: { mergedIds: dupes } });
      return { contact: after, merges };
    });
  }

  async undoMerge(actor: Actor, mergeId: string): Promise<{ survivor: ContactDto; restored: ContactDto }> {
    assertCan(actor, 'contacts:merge');
    return this.db.withTenant(actor, async (tx) => {
      const m = await tx.query(`SELECT * FROM contact_merges WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [mergeId, actor.tenantId]);
      const row = m.rows[0];
      if (!row) throw Errors.notFound('Merge');
      if (row.undone_at) throw Errors.conflict('This merge was already undone');
      if (Date.now() - new Date(row.created_at).getTime() > MERGE_UNDO_WINDOW_DAYS * 86_400_000) throw Errors.conflict(`Merges can only be undone within ${MERGE_UNDO_WINDOW_DAYS} days`);
      const snap = row.snapshot as { before: { email: string | null; phone: string | null; ownerId: string | null; tags: string[] }; identifierIds: string[]; leadIds: string[]; consentIds: string[] };

      // Bring the record back, then give it its own things back (only those still held by the survivor).
      await tx.query(`UPDATE contacts SET deleted_at = NULL, merged_into_id = NULL, email = $3, phone = $4 WHERE id = $1 AND tenant_id = $2`, [row.merged_id, actor.tenantId, snap.before.email, snap.before.phone]);
      await tx.query(`UPDATE contact_identifiers SET contact_id = $1 WHERE id = ANY($2::uuid[]) AND contact_id = $3 AND tenant_id = $4`, [row.merged_id, snap.identifierIds, row.survivor_id, actor.tenantId]);
      await tx.query(`UPDATE leads SET contact_id = $1 WHERE id = ANY($2::uuid[]) AND contact_id = $3 AND tenant_id = $4`, [row.merged_id, snap.leadIds, row.survivor_id, actor.tenantId]);
      await tx.query(`UPDATE communication_consents SET contact_id = $1 WHERE id = ANY($2::uuid[]) AND contact_id = $3 AND tenant_id = $4`, [row.merged_id, snap.consentIds, row.survivor_id, actor.tenantId]);
      await this.promotePrimaries(tx, actor.tenantId, row.merged_id);
      await this.promotePrimaries(tx, actor.tenantId, row.survivor_id);
      await tx.query(`UPDATE contact_merges SET undone_at = now() WHERE id = $1`, [mergeId]);

      const survivor = (await this.fetch(tx, actor.tenantId, row.survivor_id))!;
      const restored = (await this.fetch(tx, actor.tenantId, row.merged_id))!;
      await audit(tx, { action: 'contact.unmerge', entityType: 'contact', entityId: row.survivor_id, after: { restoredId: row.merged_id } });
      await emit(tx, { type: 'contact.updated', aggregateId: row.survivor_id, payload: { unmerged: row.merged_id } });
      await emit(tx, { type: 'contact.created', aggregateId: row.merged_id, payload: { unmerged: true } });
      return { survivor, restored };
    });
  }

  // ── consent (append-only grants; revocation closes the open grants) ─────────────────────────────────

  async consents(actor: Actor, contactId: string) {
    assertCan(actor, 'contacts:read');
    return this.db.readTenant(actor, async (tx) => {
      if (!(await this.fetch(tx, actor.tenantId, contactId))) throw Errors.notFound('Contact');
      const { rows } = await tx.query(
        `SELECT id, channel, status, source, legal_basis AS "legalBasis", proof_url AS "proofUrl", expires_at AS "expiresAt",
                revoked_at AS "revokedAt", revoke_reason AS "revokeReason", created_at AS "createdAt"
           FROM communication_consents WHERE contact_id = $1 AND tenant_id = $2 ORDER BY created_at DESC LIMIT 200`,
        [contactId, actor.tenantId]
      );
      const channels = ['email', 'sms', 'whatsapp', 'push', 'phone_call'];
      const current = channels.map((channel) => {
        const g = rows.find((r) => r.channel === channel && r.status === 'granted' && (!r.expiresAt || new Date(r.expiresAt) > new Date()));
        return { channel, granted: Boolean(g), since: g?.createdAt ?? null, source: g?.source ?? null };
      });
      return { current, history: rows };
    });
  }

  async recordConsent(
    actor: Actor,
    contactId: string,
    input: { channel: string; action: 'grant' | 'revoke'; source: string; legalBasis?: string; proofUrl?: string | null; reason?: string | null; expiresAt?: string | null }
  ) {
    assertCan(actor, 'contacts:update');
    await this.db.withTenant(actor, async (tx) => {
      const c = await tx.query(`SELECT owner_id FROM contacts WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [contactId, actor.tenantId]);
      if (!c.rows[0]) throw Errors.notFound('Contact');
      assertCanActOn(actor, 'contacts:update', c.rows[0].owner_id);
      if (input.action === 'grant') {
        await tx.query(
          `INSERT INTO communication_consents (tenant_id, contact_id, channel, status, source, legal_basis, proof_url, expires_at, ip_address)
           VALUES ($1,$2,$3::consent_channel,'granted',$4,$5,$6,$7,$8)`,
          [actor.tenantId, contactId, input.channel, input.source, input.legalBasis ?? 'consent', input.proofUrl ?? null, input.expiresAt ?? null, actor.ip ?? null]
        );
      } else {
        await tx.query(
          `UPDATE communication_consents SET status = 'revoked', revoked_at = now(), revoke_reason = $4
            WHERE contact_id = $1 AND tenant_id = $2 AND channel = $3::consent_channel AND status = 'granted'`,
          [contactId, actor.tenantId, input.channel, input.reason ?? null]
        );
      }
      await audit(tx, { action: `consent.${input.action}`, entityType: 'contact', entityId: contactId, after: { channel: input.channel, source: input.source } });
      await emit(tx, { type: 'contact.updated', aggregateId: contactId, payload: { consent: input.channel } });
    });
    return this.consents(actor, contactId);
  }

  // ── intake (leads, webhooks, imports) ───────────────────────────────────────────────────────────────

  /**
   * Resolve "who is this?" for an inbound lead: reuse the contact that already owns the e-mail / phone number, or create
   * one. Runs inside the caller's tenant transaction and is safe under concurrent intake of the same person (a unique
   * violation rolls back to a savepoint and re-reads). Unparsable phone/e-mail values are kept as plain text on the
   * contact but never become identity keys. If the e-mail and the phone belong to two different contacts the e-mail
   * match wins; callers that care can compare via `lookup`.
   */
  async findOrCreateInTx(
    tx: pg.PoolClient,
    ctx: { tenantId: string; userId: string | null },
    input: { firstName: string; lastName?: string | null; email?: string | null; phone?: string | null }
  ): Promise<{ id: string; created: boolean }> {
    const country = await this.defaultCountry(tx, ctx.tenantId);
    const email = normalizeEmail(input.email);
    const phone = normalizePhone(input.phone, country);
    const idents = this.composeIdentifiers(email, [], phone, []);
    const existing = async () => {
      const hits = await this.findDuplicates(tx, ctx.tenantId, idents);
      return hits.find((h) => h.matchedOn.includes('email')) ?? hits[0];
    };
    const found = await existing();
    if (found) return { id: found.id, created: false };

    await tx.query('SAVEPOINT intake_contact');
    try {
      const ins = await tx.query(
        `INSERT INTO contacts (tenant_id, first_name, last_name, email, phone, owner_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING id`,
        [ctx.tenantId, input.firstName.trim() || 'Unknown', blank(input.lastName), email ?? blank(input.email), phone ?? blank(input.phone), ctx.userId]
      );
      await this.insertIdentifiers(tx, ctx.tenantId, ins.rows[0].id, idents);
      await tx.query('RELEASE SAVEPOINT intake_contact');
      return { id: ins.rows[0].id as string, created: true };
    } catch (e: any) {
      if (e?.code !== '23505') throw e;
      await tx.query('ROLLBACK TO SAVEPOINT intake_contact');
      const raced = await existing();
      if (!raced) throw e;
      return { id: raced.id, created: false };
    }
  }

  // ── internals ───────────────────────────────────────────────────────────────────────────────────────

  private async fetch(tx: pg.PoolClient, tenantId: string, id: string): Promise<ContactDto | undefined> {
    const { rows } = await tx.query(`SELECT ${COLUMNS} FROM contacts c WHERE c.id = $1 AND c.tenant_id = $2 AND c.deleted_at IS NULL`, [id, tenantId]);
    const r = rows[0];
    if (!r) return undefined;
    const { _created, _updated, ...dto } = r;
    return dto as ContactDto;
  }

  private async defaultCountry(tx: pg.PoolClient, tenantId: string): Promise<string> {
    const r = await tx.query(`SELECT settings->>'defaultCountry' AS c FROM tenants WHERE id = $1`, [tenantId]);
    const c = r.rows[0]?.c as string | undefined;
    return c && /^[A-Za-z]{2}$/.test(c) ? c.toUpperCase() : 'IN';
  }

  private parseOptional(raw: string | null | undefined, path: string, norm: (v: string) => string | null, message: string, issues: FieldIssue[]): string | null {
    if (raw === null || raw === undefined || raw.trim() === '') return null;
    const v = norm(raw);
    if (!v) issues.push({ path: `body.${path}`, message, code: 'invalid_format' });
    return v;
  }

  private parseMany(raw: string[] | undefined, path: string, norm: (v: string) => string | null, message: string, issues: FieldIssue[]): string[] {
    const out: string[] = [];
    (raw ?? []).forEach((r, i) => {
      const v = norm(r);
      if (!v) issues.push({ path: `body.${path}.${i}`, message, code: 'invalid_format' });
      else if (!out.includes(v)) out.push(v);
    });
    return out;
  }

  private composeIdentifiers(email: string | null, altEmails: string[], phone: string | null, altPhones: string[]): Ident[] {
    const out: Ident[] = [];
    const add = (kind: IdentifierKind, primary: string | null, alts: string[]) => {
      if (primary) out.push({ kind, value: primary, primary: true });
      for (const a of alts) if (a !== primary && !out.some((o) => o.kind === kind && o.value === a)) out.push({ kind, value: a, primary: false });
    };
    add('email', email, altEmails);
    add('phone', phone, altPhones);
    if (out.length > 12) throw Errors.validation([{ path: 'body', message: 'A contact can have at most 12 emails and phone numbers in total' }]);
    return out;
  }

  private async findDuplicates(tx: pg.PoolClient, tenantId: string, idents: Ident[], exceptContactId?: string): Promise<DuplicateHit[]> {
    if (!idents.length) return [];
    const { rows } = await tx.query(
      `SELECT c.id, c.display_name AS "displayName", i.kind
         FROM contact_identifiers i JOIN contacts c ON c.id = i.contact_id AND c.tenant_id = i.tenant_id
        WHERE i.tenant_id = $1 AND i.released_at IS NULL AND c.deleted_at IS NULL
          AND (i.kind, i.value) IN (SELECT k::identifier_kind, v FROM unnest($2::text[], $3::text[]) AS t(k, v))
          AND ($4::uuid IS NULL OR c.id <> $4)`,
      [tenantId, idents.map((i) => i.kind), idents.map((i) => i.value), exceptContactId ?? null]
    );
    const by = new Map<string, DuplicateHit>();
    for (const r of rows) {
      const hit: DuplicateHit = by.get(r.id) ?? { id: r.id, displayName: r.displayName, matchedOn: [] };
      if (!hit.matchedOn.includes(r.kind)) hit.matchedOn.push(r.kind);
      by.set(r.id, hit);
    }
    return [...by.values()];
  }

  private async assertNoDuplicates(tx: pg.PoolClient, tenantId: string, idents: Ident[], exceptContactId?: string) {
    const dupes = await this.findDuplicates(tx, tenantId, idents, exceptContactId);
    if (dupes.length) {
      const what = [...new Set(dupes.flatMap((d) => d.matchedOn))].map((k) => (k === 'email' ? 'email address' : 'phone number')).join(' and ');
      throw Errors.conflict(`A contact with this ${what} already exists`, { extensions: { reason: 'duplicate_contact', duplicates: dupes } });
    }
  }

  private async insertIdentifiers(tx: pg.PoolClient, tenantId: string, contactId: string, idents: Ident[]) {
    if (!idents.length) return;
    await tx.query(
      `INSERT INTO contact_identifiers (tenant_id, contact_id, kind, value, is_primary)
       SELECT $1, $2, k::identifier_kind, v, p FROM unnest($3::text[], $4::text[], $5::boolean[]) AS t(k, v, p)`,
      [tenantId, contactId, idents.map((i) => i.kind), idents.map((i) => i.value), idents.map((i) => i.primary)]
    );
  }

  /** Make the live identifiers of the touched kinds exactly equal `next` (delete / insert / re-flag). */
  private async replaceIdentifiers(tx: pg.PoolClient, tenantId: string, contactId: string, next: Ident[], touched: { email: boolean; phone: boolean }) {
    const kinds: IdentifierKind[] = [...(touched.email ? (['email'] as const) : []), ...(touched.phone ? (['phone'] as const) : [])];
    const cur = await tx.query(`SELECT id, kind, value FROM contact_identifiers WHERE contact_id = $1 AND tenant_id = $2 AND released_at IS NULL AND kind = ANY($3::identifier_kind[]) FOR UPDATE`, [contactId, tenantId, kinds]);
    const wanted = new Set(next.filter((n) => kinds.includes(n.kind)).map((n) => `${n.kind}:${n.value}`));
    const have = new Set(cur.rows.map((r) => `${r.kind}:${r.value}`));
    const drop = cur.rows.filter((r) => !wanted.has(`${r.kind}:${r.value}`)).map((r) => r.id);
    if (drop.length) await tx.query(`DELETE FROM contact_identifiers WHERE id = ANY($1::uuid[])`, [drop]);
    await tx.query(`UPDATE contact_identifiers SET is_primary = false WHERE contact_id = $1 AND tenant_id = $2 AND kind = ANY($3::identifier_kind[]) AND released_at IS NULL`, [contactId, tenantId, kinds]);
    const add = next.filter((n) => kinds.includes(n.kind) && !have.has(`${n.kind}:${n.value}`));
    await this.insertIdentifiers(tx, tenantId, contactId, add.map((a) => ({ ...a, primary: false })));
    for (const p of next.filter((n) => n.primary && kinds.includes(n.kind))) {
      await tx.query(`UPDATE contact_identifiers SET is_primary = true WHERE contact_id = $1 AND tenant_id = $2 AND kind = $3::identifier_kind AND value = $4 AND released_at IS NULL`, [contactId, tenantId, p.kind, p.value]);
    }
  }

  /** Keep contacts.email/phone (display copy) and the is_primary flags consistent after identifiers moved. */
  private async promotePrimaries(tx: pg.PoolClient, tenantId: string, contactId: string) {
    for (const kind of ['email', 'phone'] as const) {
      const has = await tx.query(`SELECT 1 FROM contact_identifiers WHERE contact_id = $1 AND tenant_id = $2 AND kind = $3::identifier_kind AND is_primary AND released_at IS NULL`, [contactId, tenantId, kind]);
      if (!has.rowCount) {
        await tx.query(
          `UPDATE contact_identifiers SET is_primary = true WHERE id = (
             SELECT id FROM contact_identifiers WHERE contact_id = $1 AND tenant_id = $2 AND kind = $3::identifier_kind AND released_at IS NULL ORDER BY created_at, id LIMIT 1)`,
          [contactId, tenantId, kind]
        );
      }
      const col = kind === 'email' ? 'email' : 'phone';
      await tx.query(
        `UPDATE contacts SET ${col} = (SELECT value FROM contact_identifiers WHERE contact_id = $1 AND tenant_id = $2 AND kind = $3::identifier_kind AND is_primary AND released_at IS NULL)
          WHERE id = $1 AND tenant_id = $2`,
        [contactId, tenantId, kind]
      );
    }
  }

  /**
   * Owner must be an active member. Managers may assign anyone (or nobody); agents (own-scope) only ever own what
   * they create or take for themselves.
   */
  private async resolveOwner(tx: pg.PoolClient, actor: Actor, requested: string | null | undefined, defaultOwner: string | null): Promise<string | null> {
    const manager = actor.kind === 'system' || scopeOf(actor.role, 'contacts:update') === 'all';
    let owner: string | null;
    if (requested === undefined) owner = defaultOwner;
    else {
      if (!manager && requested !== actor.userId) throw Errors.forbidden('Only managers can assign a contact to someone else');
      owner = requested;
    }
    if (!owner) return null;
    const m = await tx.query(`SELECT 1 FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active' AND is_active`, [actor.tenantId, owner]);
    if (!m.rowCount) throw Errors.validation([{ path: 'body.ownerId', message: 'Owner must be an active member of this workspace' }]);
    return owner;
  }
}

function blank(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}
