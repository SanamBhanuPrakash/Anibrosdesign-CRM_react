import crypto from 'crypto';
import type pg from 'pg';
import type { Database } from '../../platform/db';
import { assertCan, type Actor } from '../../platform/authz/actor';
import { Errors } from '../../platform/errors';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/events';
import { enqueue, PermanentJobError, type JobHandler } from '../../platform/jobs';
import { ContactsService } from '../contacts/service';
import { normalizeEmail, normalizePhone, normalizeTags } from '../contacts/normalize';
import { CsvError, parseCsv } from './csv';
import { LEAD_SOURCES, LeadsService, type LeadInput, type LeadSource } from './service';

/**
 * CSV lead import.
 *
 *  API (this file, `ImportService`): validates the upload, auto-detects which column is which, stores the file and
 *  enqueues a job — it never processes rows inside the HTTP request.
 *  Worker (`leadsImportHandler`): processes 100 rows per transaction. Progress is written in the SAME transaction as the
 *  rows it covers, so a crash or retry resumes at the last committed batch: every row is processed exactly once.
 *  Per-row problems never abort the file: they are counted and the first 200 are kept with their row number.
 */
export const IMPORT_FIELDS = ['firstName', 'lastName', 'fullName', 'email', 'phone', 'source', 'estimatedValue', 'budgetMin', 'budgetMax', 'bedroomsMin', 'locations', 'tags', 'campaign', 'ownerEmail', 'stage', 'notes'] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

const SYNONYMS: Record<ImportField, string[]> = {
  firstName: ['first name', 'firstname', 'first', 'given name'],
  lastName: ['last name', 'lastname', 'surname', 'family name'],
  fullName: ['name', 'full name', 'fullname', 'customer name', 'lead name', 'contact name', 'client name'],
  email: ['email', 'e-mail', 'email address', 'mail'],
  phone: ['phone', 'mobile', 'mobile number', 'phone number', 'contact number', 'cell', 'whatsapp', 'telephone'],
  source: ['source', 'lead source', 'channel', 'origin'],
  estimatedValue: ['value', 'deal value', 'estimated value', 'amount', 'price'],
  budgetMin: ['budget min', 'min budget', 'budget from'],
  budgetMax: ['budget', 'budget max', 'max budget', 'budget to'],
  bedroomsMin: ['bedrooms', 'bhk', 'beds', 'bedroom'],
  locations: ['location', 'locations', 'locality', 'area', 'city', 'preferred location'],
  tags: ['tags', 'labels', 'tag'],
  campaign: ['campaign', 'campaign name', 'utm campaign', 'ad'],
  ownerEmail: ['owner', 'owner email', 'assigned to', 'agent', 'agent email', 'sales rep'],
  stage: ['stage', 'status', 'pipeline stage'],
  notes: ['notes', 'note', 'remarks', 'comments', 'comment', 'message'],
};

const SOURCE_ALIASES: Record<string, LeadSource> = {
  website: 'website', web: 'website', 'web form': 'website', form: 'website', referral: 'referral', reference: 'referral', 'word of mouth': 'referral',
  portal: 'portal', '99acres': 'portal', magicbricks: 'portal', housing: 'portal', 'housing.com': 'portal', direct: 'direct', call: 'direct', phone: 'direct',
  facebook: 'meta_ads', instagram: 'meta_ads', meta: 'meta_ads', 'meta ads': 'meta_ads', 'facebook ads': 'meta_ads', google: 'google_ads', 'google ads': 'google_ads',
  adwords: 'google_ads', 'walk in': 'walk_in', 'walk-in': 'walk_in', walkin: 'walk_in', other: 'other',
};

const norm = (h: string) => h.toLowerCase().replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Header → field, first match wins, each field used once. Returns what was understood so the UI can show/override it. */
export function detectMapping(header: string[]): Record<string, ImportField> {
  const out: Record<string, ImportField> = {};
  const used = new Set<ImportField>();
  const normalised = header.map(norm);
  for (const field of IMPORT_FIELDS) {
    const idx = normalised.findIndex((h, i) => !out[header[i]!] && SYNONYMS[field].some((syn) => norm(syn) === h));
    if (idx >= 0 && !used.has(field)) {
      out[header[idx]!] = field;
      used.add(field);
    }
  }
  return out;
}

export interface ImportJobDto {
  id: string;
  kind: 'leads';
  status: 'queued' | 'running' | 'completed' | 'failed';
  fileName: string | null;
  totalRows: number;
  processedRows: number;
  createdCount: number;
  matchedCount: number;
  skippedCount: number;
  errorCount: number;
  errors: Array<{ row: number; field?: string; message: string }>;
  mapping: Record<string, string>;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

const COLUMNS = `id, kind, status, file_name AS "fileName", total_rows AS "totalRows", processed_rows AS "processedRows", created_count AS "createdCount", matched_count AS "matchedCount",
  skipped_count AS "skippedCount", error_count AS "errorCount", errors, mapping, created_at AS "createdAt", started_at AS "startedAt", finished_at AS "finishedAt"`;
const MAX_BYTES = 5 * 1024 * 1024;
const BATCH = 100;

export class ImportService {
  constructor(private db: Database) {}

  async create(actor: Actor, input: { fileName?: string; csv: string; mapping?: Record<string, ImportField>; onDuplicate?: 'skip' | 'create'; defaultSource?: LeadSource; ownerId?: string | null }): Promise<ImportJobDto & { detectedMapping: Record<string, ImportField> }> {
    assertCan(actor, 'leads:import');
    if (Buffer.byteLength(input.csv) > MAX_BYTES) throw Errors.payloadTooLarge('Import files can be at most 5 MB (about 40,000 rows). Split the file and import it in parts.');
    let parsed;
    try {
      parsed = parseCsv(input.csv, { maxRows: 40_000 });
    } catch (e) {
      if (e instanceof CsvError) throw Errors.validation([{ path: 'body.csv', message: e.message }]);
      throw e;
    }
    if (!parsed.rows.length) throw Errors.validation([{ path: 'body.csv', message: 'The file has a header but no rows' }]);

    const detected = detectMapping(parsed.header);
    const mapping = input.mapping ?? detected;
    for (const h of Object.keys(mapping)) if (!parsed.header.includes(h)) throw Errors.validation([{ path: 'body.mapping', message: `The file has no column called “${h}”` }]);
    const fields = new Set(Object.values(mapping));
    const issues: Array<{ path: string; message: string; code?: string }> = [];
    if (!fields.has('fullName') && !fields.has('firstName')) issues.push({ path: 'body.mapping', message: 'No column was recognised as the person’s name. Map one to “fullName” or “firstName”.', code: 'missing_name' });
    if (!fields.has('email') && !fields.has('phone')) issues.push({ path: 'body.mapping', message: 'No column was recognised as an email or phone number. Map at least one.', code: 'missing_contact' });
    if (issues.length) throw Errors.validation(issues, `We couldn’t tell which columns are which. Found: ${parsed.header.join(', ')}`);

    const sha = crypto.createHash('sha256').update(input.csv).digest('hex');
    return this.db.withTenant(actor, async (tx) => {
      try {
        const ins = await tx.query(
          `INSERT INTO import_jobs (tenant_id, kind, file_name, file_sha256, payload_csv, mapping, options, total_rows, created_by)
           VALUES ($1,'leads',$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8) RETURNING id`,
          [actor.tenantId, input.fileName?.slice(0, 200) ?? null, sha, input.csv, JSON.stringify(mapping), JSON.stringify({ onDuplicate: input.onDuplicate ?? 'skip', defaultSource: input.defaultSource ?? 'other', ownerId: input.ownerId ?? null }), parsed.rows.length, actor.userId]
        );
        const id = ins.rows[0].id as string;
        await enqueue(tx, { type: 'leads.import', payload: { importId: id }, dedupeKey: `import:${id}`, maxAttempts: 3 });
        await audit(tx, { action: 'import.create', entityType: 'import', entityId: id, after: { rows: parsed.rows.length, fileName: input.fileName } });
        await emit(tx, { type: 'import.updated', aggregateId: id, payload: { status: 'queued' } });
        return { ...(await this.fetch(tx, actor.tenantId, id))!, detectedMapping: detected };
      } catch (e: any) {
        if (e?.code === '23505') throw Errors.conflict('This exact file is already being imported');
        throw e;
      }
    });
  }

  async list(actor: Actor): Promise<ImportJobDto[]> {
    assertCan(actor, 'leads:import');
    return this.db.readTenant(actor, async (tx) => (await tx.query(`SELECT ${COLUMNS} FROM import_jobs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50`, [actor.tenantId])).rows as ImportJobDto[]);
  }

  async get(actor: Actor, id: string): Promise<ImportJobDto> {
    assertCan(actor, 'leads:import');
    return this.db.readTenant(actor, async (tx) => {
      const r = await this.fetch(tx, actor.tenantId, id);
      if (!r) throw Errors.notFound('Import');
      return r;
    });
  }

  private async fetch(tx: pg.PoolClient, tenantId: string, id: string) {
    return (await tx.query(`SELECT ${COLUMNS} FROM import_jobs WHERE id = $1 AND tenant_id = $2`, [id, tenantId])).rows[0] as ImportJobDto | undefined;
  }
}

// ── worker side ────────────────────────────────────────────────────────────────────────────────────────

const num = (v: string | undefined): number | null | 'bad' => {
  const t = (v ?? '').replace(/[,₹$\s]/g, '').replace(/^(\d+(?:\.\d+)?)\s*(l|lac|lakh|lakhs)$/i, (_m, n) => String(Number(n) * 100_000)).replace(/^(\d+(?:\.\d+)?)\s*(cr|crore|crores)$/i, (_m, n) => String(Number(n) * 10_000_000));
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n < 1e13 ? n : 'bad';
};

export const leadsImportHandler: JobHandler = async (job, ctx) => {
  try {
    return await runImport(job, ctx);
  } catch (e: any) {
    // Out of retries (or unrecoverable): say so on the import instead of leaving it "running" forever.
    if (job.tenantId && (e instanceof PermanentJobError || job.attempts >= job.maxAttempts)) {
      await ctx.db
        .withTenant({ tenantId: job.tenantId }, async (tx) => {
          await tx.query(`UPDATE import_jobs SET status = 'failed', finished_at = now(), payload_csv = NULL, errors = errors || $3::jsonb WHERE id = $1 AND tenant_id = $2`, [String(job.payload.importId), job.tenantId, JSON.stringify([{ row: 0, message: String(e?.message ?? e).slice(0, 300) }])]);
          await emit(tx, { type: 'import.updated', aggregateId: String(job.payload.importId), payload: { status: 'failed' } });
        })
        .catch(() => undefined);
    }
    throw e;
  }
};

async function runImport(job: Parameters<JobHandler>[0], ctx: Parameters<JobHandler>[1]) {
  const importId = String(job.payload.importId ?? '');
  const tenantId = job.tenantId;
  if (!tenantId || !importId) throw new PermanentJobError('Malformed import job');
  const tid: string = tenantId;
  const contacts = new ContactsService(ctx.db);
  const leads = new LeadsService(ctx.db, contacts);

  const meta = await ctx.db.withTenant({ tenantId }, async (tx) => (await tx.query(`SELECT * FROM import_jobs WHERE id = $1 AND tenant_id = $2`, [importId, tenantId])).rows[0]);
  if (!meta) throw new PermanentJobError('Import not found');
  if (meta.status === 'completed' || meta.status === 'failed') return { skipped: true };
  if (!meta.payload_csv) throw new PermanentJobError('Import file is gone');

  const parsed = parseCsv(meta.payload_csv, { maxRows: 40_000 });
  const mapping = meta.mapping as Record<string, ImportField>;
  const opts = meta.options as { onDuplicate: 'skip' | 'create'; defaultSource: LeadSource; ownerId: string | null };
  const colOf = new Map<ImportField, number>();
  for (const [h, f] of Object.entries(mapping)) colOf.set(f, parsed.header.indexOf(h));
  const cell = (row: string[], f: ImportField) => (colOf.has(f) ? (row[colOf.get(f)!] ?? '').trim() : '');
  const actorFor = (): Actor => ({ tenantId, userId: meta.created_by, role: 'tenant_owner', kind: 'system' });

  await ctx.db.withTenant({ tenantId, userId: meta.created_by }, async (tx) => {
    await tx.query(`UPDATE import_jobs SET status = 'running', started_at = COALESCE(started_at, now()) WHERE id = $1 AND tenant_id = $2`, [importId, tenantId]);
    await emit(tx, { type: 'import.updated', aggregateId: importId, payload: { status: 'running' } });
  });

  for (;;) {
    if (ctx.signal.aborted) throw new Error('Lease lost while importing; another worker will resume');
    const done = await ctx.db.withTenant({ tenantId, userId: meta.created_by }, async (tx) => {
      const cur = (await tx.query(`SELECT processed_rows FROM import_jobs WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [importId, tenantId])).rows[0];
      const offset = cur.processed_rows as number;
      if (offset >= parsed.rows.length) return true;
      const slice = parsed.rows.slice(offset, offset + BATCH);
      const stats = { created: 0, matched: 0, skipped: 0, errors: [] as Array<{ row: number; field?: string; message: string }> };
      for (const [i, row] of slice.entries()) {
        const rowNo = offset + i + 2; // 1-based and the header is row 1: matches what the user sees in a spreadsheet
        await tx.query('SAVEPOINT import_row');
        try {
          await importRow(tx, row, stats);
          await tx.query('RELEASE SAVEPOINT import_row');
        } catch (e: any) {
          await tx.query('ROLLBACK TO SAVEPOINT import_row');
          if (e?.status && e.status < 500) stats.errors.push({ row: rowNo, field: e.errors?.[0]?.path?.replace(/^body\./, ''), message: e.errors?.[0]?.message ?? e.detail ?? e.message });
          else stats.errors.push({ row: rowNo, message: 'Unexpected error while saving this row' });
        }
      }
      await tx.query(
        `UPDATE import_jobs SET processed_rows = processed_rows + $3, created_count = created_count + $4, matched_count = matched_count + $5, skipped_count = skipped_count + $6,
                error_count = error_count + $7, errors = (SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM (SELECT e FROM jsonb_array_elements(errors || $8::jsonb) e LIMIT 200) q)
          WHERE id = $1 AND tenant_id = $2`,
        [importId, tenantId, slice.length, stats.created, stats.matched, stats.skipped, stats.errors.length, JSON.stringify(stats.errors.slice(0, 200))]
      );
      await emit(tx, { type: 'import.updated', aggregateId: importId, payload: { status: 'running', processed: offset + slice.length } });
      return offset + slice.length >= parsed.rows.length;
    });
    if (done) break;
  }

  await ctx.db.withTenant({ tenantId, userId: meta.created_by }, async (tx) => {
    const r = await tx.query(`UPDATE import_jobs SET status = 'completed', finished_at = now(), payload_csv = NULL WHERE id = $1 AND tenant_id = $2 RETURNING created_count, matched_count, skipped_count, error_count`, [importId, tenantId]);
    await audit(tx, { action: 'import.complete', entityType: 'import', entityId: importId, after: r.rows[0] });
    await emit(tx, { type: 'import.updated', aggregateId: importId, payload: { status: 'completed' } });
  });
  return { rows: parsed.rows.length };

  async function importRow(tx: pg.PoolClient, row: string[], stats: { created: number; matched: number; skipped: number }) {
    const actor = actorFor();
    const issues = (field: string, message: string) => Errors.validation([{ path: `body.${field}`, message }]);

    let first = cell(row, 'firstName');
    let last = cell(row, 'lastName');
    if (!first) {
      const full = cell(row, 'fullName');
      const parts = full.split(/\s+/).filter(Boolean);
      first = parts.shift() ?? '';
      last = last || parts.join(' ');
    }
    if (!first) throw issues('name', 'Name is empty');
    const emailRaw = cell(row, 'email');
    const phoneRaw = cell(row, 'phone');
    if (!emailRaw && !phoneRaw) throw issues('email', 'Needs an email address or a phone number');
    if (emailRaw && !normalizeEmail(emailRaw)) throw issues('email', `“${emailRaw}” is not a valid email address`);
    if (phoneRaw && !normalizePhone(phoneRaw, 'IN')) throw issues('phone', `“${phoneRaw}” is not a valid phone number`);

    const sourceRaw = cell(row, 'source').toLowerCase();
    const source: LeadSource = !sourceRaw ? opts.defaultSource : ((LEAD_SOURCES as readonly string[]).includes(sourceRaw) ? (sourceRaw as LeadSource) : (SOURCE_ALIASES[sourceRaw] ?? 'other'));
    const numbers = { estimatedValue: num(cell(row, 'estimatedValue')), budgetMin: num(cell(row, 'budgetMin')), budgetMax: num(cell(row, 'budgetMax')), bedroomsMin: num(cell(row, 'bedroomsMin')) };
    for (const [k, v] of Object.entries(numbers)) if (v === 'bad') throw issues(k, `“${cell(row, k as ImportField)}” is not a number`);
    const n = numbers as Record<string, number | null>;
    if (n.budgetMin !== null && n.budgetMax !== null && n.budgetMin > n.budgetMax) throw issues('budgetMin', 'Budget min is greater than budget max');

    let ownerId: string | null | undefined = opts.ownerId ?? undefined;
    const ownerEmail = normalizeEmail(cell(row, 'ownerEmail'));
    if (ownerEmail) {
      const o = await tx.query(`SELECT u.id FROM tenant_memberships tm JOIN users u ON u.id = tm.user_id WHERE tm.tenant_id = $1 AND u.email = $2 AND tm.status = 'active'`, [tid, ownerEmail]);
      if (!o.rows[0]) throw issues('ownerEmail', `No active team member with email ${ownerEmail}`);
      ownerId = o.rows[0].id;
    }

    let stageId: string | undefined;
    const stageName = cell(row, 'stage');
    if (stageName) {
      const s = await tx.query(
        `SELECT s.id FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id AND p.tenant_id = s.tenant_id AND p.is_default AND p.archived_at IS NULL
          WHERE s.tenant_id = $1 AND s.archived_at IS NULL AND s.maps_to_status NOT IN ('won','lost','disqualified') AND (lower(s.name) = lower($2) OR s.stage_key = $3)`,
        [tid, stageName, stageName.toLowerCase().replace(/[^a-z0-9]+/g, '_')]
      );
      if (!s.rows[0]) throw issues('stage', `“${stageName}” is not an open stage of your default pipeline`);
      stageId = s.rows[0].id;
    }

    const found = await contacts.findOrCreateInTx(tx, { tenantId: tid, userId: meta.created_by }, { firstName: first, lastName: last || null, email: emailRaw || null, phone: phoneRaw || null });
    if (!found.created) stats.matched++;
    const input: LeadInput = {
      contactId: found.id,
      source,
      stageId,
      ownerId,
      estimatedValue: n.estimatedValue,
      budgetMin: n.budgetMin,
      budgetMax: n.budgetMax,
      bedroomsMin: n.bedroomsMin,
      locations: cell(row, 'locations').split(/[;|]/).map((x) => x.trim()).filter(Boolean),
      tags: normalizeTags(cell(row, 'tags').split(/[;|,]/)),
      campaign: cell(row, 'campaign') || null,
      allowDuplicate: opts.onDuplicate === 'create',
    };
    try {
      const lead = await leads.createInTx(tx, actor, input);
      stats.created++;
      const notes = cell(row, 'notes');
      if (notes) await tx.query(`INSERT INTO activities (tenant_id, lead_id, user_id, type, description, metadata) VALUES ($1,$2,$3,'note',$4,'{"event":"import"}'::jsonb)`, [tid, lead.id, meta.created_by, notes.slice(0, 2000)]);
    } catch (e: any) {
      if (e?.extensions?.reason === 'duplicate_lead') {
        stats.skipped++;
        return;
      }
      throw e;
    }
  }
}
