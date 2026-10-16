import type pg from 'pg';
import type { Database } from '../../platform/db';
import { assertCan, type Actor } from '../../platform/authz/actor';
import { Errors } from '../../platform/errors';
import { audit } from '../../platform/audit';
import { CsvError, parseCsv } from '../leads/csv';
import { LEAD_SOURCE_KEYS, SOURCE_LABEL, sourceLabel, type SourceKey } from './channels';

/**
 * Marketing spend, entered by hand or by CSV (decision D5; syncing from ad platforms needs accounts and comes later).
 * One figure per source, campaign and exact period; periods for the same source and campaign may not overlap, so money can never be counted twice.
 * A row without a campaign is spend for the whole source. Reports spread each entry evenly over its own days.
 */
export interface SpendDto {
  id: string;
  source: string;
  sourceLabel: string;
  campaign: string | null;
  periodStart: string;
  periodEnd: string;
  amount: number;
  currency: string;
  note: string | null;
  version: number;
  enteredBy: string | null;
  createdAt: string;
}
export interface SpendInput {
  source: SourceKey;
  campaign?: string | null;
  periodStart: string;
  periodEnd: string;
  amount: number;
  note?: string | null;
}
export interface RowIssue {
  row: number;
  message: string;
}

const COLUMNS = `s.id, s.source::text AS source, s.campaign, to_char(s.period_start, 'YYYY-MM-DD') AS "periodStart", to_char(s.period_end, 'YYYY-MM-DD') AS "periodEnd", s.amount::float8 AS amount,
  s.currency, s.note, s.version, u.name AS "enteredBy", s.created_at AS "createdAt"`;
const FROM = `marketing_spend s LEFT JOIN users u ON u.id = s.entered_by`;
const toDto = (r: any): SpendDto => ({ ...r, sourceLabel: sourceLabel(r.source) });

const clean = (v: string | null | undefined) => (v?.trim() ? v.trim().replace(/\s+/g, ' ') : null);

export class SpendService {
  constructor(private db: Database) {}

  async list(actor: Actor, q: { from?: string; to?: string }): Promise<SpendDto[]> {
    assertCan(actor, 'attribution:read');
    return this.db.readTenant(actor, async (tx) => {
      const params: unknown[] = [actor.tenantId];
      const where = ['s.tenant_id = $1'];
      if (q.from) where.push(`s.period_end >= $${params.push(q.from)}::date`);
      if (q.to) where.push(`s.period_start <= $${params.push(q.to)}::date`);
      const r = await tx.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE ${where.join(' AND ')} ORDER BY s.period_start DESC, s.id DESC LIMIT 500`, params);
      return r.rows.map(toDto);
    });
  }

  async create(actor: Actor, input: SpendInput): Promise<SpendDto> {
    assertCan(actor, 'attribution:manage');
    return this.db.withTenant(actor, async (tx) => {
      const currency = await workspaceCurrency(tx, actor.tenantId);
      const id = await this.insert(tx, actor, input, currency, null);
      await audit(tx, { action: 'spend.create', entityType: 'marketing_spend', entityId: id, after: { source: input.source, campaign: clean(input.campaign), periodStart: input.periodStart, periodEnd: input.periodEnd, amount: input.amount } });
      return this.fetch(tx, actor.tenantId, id);
    });
  }

  async update(actor: Actor, id: string, patch: Partial<Omit<SpendInput, 'source'>>, expectedVersion?: number): Promise<SpendDto> {
    assertCan(actor, 'attribution:manage');
    return this.db.withTenant(actor, async (tx) => {
      const cur = (await tx.query(`SELECT source::text AS source, campaign, to_char(period_start, 'YYYY-MM-DD') AS ps, to_char(period_end, 'YYYY-MM-DD') AS pe, amount::float8 AS amount, version FROM marketing_spend WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [id, actor.tenantId])).rows[0];
      if (!cur) throw Errors.notFound('Spend entry');
      if (expectedVersion !== undefined && expectedVersion !== cur.version) throw Errors.preconditionFailed();
      const next = {
        campaign: patch.campaign !== undefined ? clean(patch.campaign) : (cur.campaign as string | null),
        periodStart: patch.periodStart ?? (cur.ps as string),
        periodEnd: patch.periodEnd ?? (cur.pe as string),
        amount: patch.amount ?? (cur.amount as number),
      };
      assertPeriod(next.periodStart, next.periodEnd);
      await lockSource(tx, actor.tenantId, cur.source);
      await assertNoOverlap(tx, actor.tenantId, cur.source, next.campaign, next.periodStart, next.periodEnd, id);
      try {
        await tx.query(
          `UPDATE marketing_spend SET campaign = $3, period_start = $4::date, period_end = $5::date, amount = $6, note = CASE WHEN $7::boolean THEN $8 ELSE note END, version = version + 1 WHERE id = $1 AND tenant_id = $2`,
          [id, actor.tenantId, next.campaign, next.periodStart, next.periodEnd, next.amount, patch.note !== undefined, clean(patch.note)]
        );
      } catch (e) {
        throw mapSpendError(e);
      }
      await audit(tx, { action: 'spend.update', entityType: 'marketing_spend', entityId: id, before: { campaign: cur.campaign, periodStart: cur.ps, periodEnd: cur.pe, amount: cur.amount }, after: next });
      return this.fetch(tx, actor.tenantId, id);
    });
  }

  async remove(actor: Actor, id: string): Promise<void> {
    assertCan(actor, 'attribution:manage');
    await this.db.withTenant(actor, async (tx) => {
      const r = await tx.query(`DELETE FROM marketing_spend WHERE id = $1 AND tenant_id = $2 RETURNING source::text AS source, campaign, to_char(period_start, 'YYYY-MM-DD') AS ps, to_char(period_end, 'YYYY-MM-DD') AS pe, amount::float8 AS amount`, [id, actor.tenantId]);
      if (!r.rowCount) throw Errors.notFound('Spend entry');
      await audit(tx, { action: 'spend.delete', entityType: 'marketing_spend', entityId: id, before: r.rows[0] });
    });
  }

  /**
   * CSV import. Columns (by header): source, campaign (optional), from, to, amount, note (optional). Dates are YYYY-MM-DD. The whole file is checked first and
   * nothing is saved if any row is wrong (money is not imported "mostly"). A row that repeats an entry already saved is skipped, so importing the same file
   * twice changes nothing. `dryRun` reports what would happen without saving.
   */
  async importCsv(actor: Actor, input: { csv: string; dryRun: boolean }): Promise<{ dryRun: boolean; created: number; skipped: number; errors: RowIssue[]; preview: Array<{ row: number; source: string; sourceLabel: string; campaign: string | null; periodStart: string; periodEnd: string; amount: number; status: 'new' | 'already_saved' }> }> {
    assertCan(actor, 'attribution:manage');
    let parsed;
    try {
      parsed = parseCsv(input.csv, { maxRows: 1000, maxColumns: 12 });
    } catch (e) {
      if (e instanceof CsvError) throw Errors.validation([{ path: 'body.csv', message: e.message }]);
      throw e;
    }
    const col = (names: string[]) => parsed.header.findIndex((h) => names.includes(h.toLowerCase().replace(/[^a-z]/g, '')));
    const idx = { source: col(['source', 'channel', 'platform']), campaign: col(['campaign', 'campaignname']), from: col(['from', 'start', 'startdate', 'periodstart']), to: col(['to', 'end', 'enddate', 'periodend']), amount: col(['amount', 'spend', 'cost']), note: col(['note', 'notes']) };
    const missing = (['source', 'from', 'to', 'amount'] as const).filter((k) => idx[k] < 0);
    if (missing.length) throw Errors.validation([{ path: 'body.csv', message: `The file needs these columns: ${missing.join(', ')} (a header row naming them, e.g. source, campaign, from, to, amount)` }]);
    if (!parsed.rows.length) throw Errors.validation([{ path: 'body.csv', message: 'The file has a header but no rows' }]);

    const errors: RowIssue[] = [];
    const rows: Array<{ row: number; input: SpendInput }> = [];
    parsed.rows.forEach((cells, i) => {
      const row = i + 2; // as a spreadsheet shows it: header is row 1
      const get = (k: keyof typeof idx) => (idx[k] >= 0 ? (cells[idx[k]] ?? '').trim() : '');
      const src = matchSource(get('source'));
      if (!src) return void errors.push({ row, message: `Unknown source “${get('source')}”. Use one of: ${LEAD_SOURCE_KEYS.filter((s) => s !== 'other').map((s) => SOURCE_LABEL[s]).join(', ')}` });
      const from = get('from');
      const to = get('to');
      if (!isIsoDate(from) || !isIsoDate(to)) return void errors.push({ row, message: 'Dates must look like 2026-10-14' });
      try {
        assertPeriod(from, to);
      } catch (e: any) {
        return void errors.push({ row, message: e.errors?.[0]?.message ?? e.detail ?? 'Invalid dates' });
      }
      const amount = parseAmount(get('amount'));
      if (amount === null) return void errors.push({ row, message: `“${get('amount')}” is not an amount` });
      const campaign = clean(get('campaign'));
      if (campaign && campaign.length > 150) return void errors.push({ row, message: 'Campaign names are limited to 150 characters' });
      rows.push({ row, input: { source: src, campaign, periodStart: from, periodEnd: to, amount, note: clean(get('note'))?.slice(0, 300) ?? null } });
    });
    // overlaps inside the file itself
    for (let a = 0; a < rows.length; a++) {
      for (let b = a + 1; b < rows.length; b++) {
        const x = rows[a]!.input;
        const y = rows[b]!.input;
        if (x.source === y.source && (x.campaign ?? '').toLowerCase() === (y.campaign ?? '').toLowerCase() && x.periodStart <= y.periodEnd && y.periodStart <= x.periodEnd) {
          const same = x.periodStart === y.periodStart && x.periodEnd === y.periodEnd;
          errors.push({ row: rows[b]!.row, message: same ? `Repeats row ${rows[a]!.row} (same source, campaign and dates)` : `Its dates overlap row ${rows[a]!.row} for the same source and campaign` });
        }
      }
    }
    if (errors.length) {
      throw Errors.validation(errors.slice(0, 50).map((e) => ({ path: `row ${e.row}`, message: e.message })), `${errors.length} row${errors.length === 1 ? '' : 's'} could not be imported; nothing was saved`);
    }

    return this.db.withTenant(actor, async (tx) => {
      const currency = await workspaceCurrency(tx, actor.tenantId);
      const batch = (await tx.query(`SELECT gen_random_uuid() AS id`)).rows[0].id as string;
      const preview: Array<{ row: number; source: string; sourceLabel: string; campaign: string | null; periodStart: string; periodEnd: string; amount: number; status: 'new' | 'already_saved' }> = [];
      let created = 0;
      let skipped = 0;
      for (const r of rows) {
        const i = r.input;
        await lockSource(tx, actor.tenantId, i.source);
        const same = await tx.query(
          `SELECT 1 FROM marketing_spend WHERE tenant_id = $1 AND source = $2::lead_source AND lower(coalesce(campaign, '')) = lower($3) AND period_start = $4::date AND period_end = $5::date`,
          [actor.tenantId, i.source, i.campaign ?? '', i.periodStart, i.periodEnd]
        );
        const base = { row: r.row, source: i.source, sourceLabel: sourceLabel(i.source), campaign: i.campaign ?? null, periodStart: i.periodStart, periodEnd: i.periodEnd, amount: i.amount };
        if (same.rowCount) {
          skipped++;
          preview.push({ ...base, status: 'already_saved' });
          continue;
        }
        await assertNoOverlap(tx, actor.tenantId, i.source, i.campaign ?? null, i.periodStart, i.periodEnd, null, r.row);
        if (!input.dryRun) await this.insert(tx, actor, i, currency, batch);
        created++;
        preview.push({ ...base, status: 'new' });
      }
      if (!input.dryRun) await audit(tx, { action: 'spend.import', entityType: 'marketing_spend', entityId: batch, after: { created, skipped } });
      return { dryRun: input.dryRun, created, skipped, errors: [], preview: preview.slice(0, 200) };
    });
  }

  private async insert(tx: pg.PoolClient, actor: Actor, i: SpendInput, currency: string, batch: string | null): Promise<string> {
    assertPeriod(i.periodStart, i.periodEnd);
    const campaign = clean(i.campaign);
    await lockSource(tx, actor.tenantId, i.source);
    await assertNoOverlap(tx, actor.tenantId, i.source, campaign, i.periodStart, i.periodEnd, null);
    try {
      const r = await tx.query(
        `INSERT INTO marketing_spend (tenant_id, source, campaign, period_start, period_end, amount, currency, note, import_batch, entered_by)
         VALUES ($1,$2::lead_source,$3,$4::date,$5::date,$6,$7,$8,$9,$10) RETURNING id`,
        [actor.tenantId, i.source, campaign, i.periodStart, i.periodEnd, i.amount, currency, clean(i.note), batch, actor.userId]
      );
      return r.rows[0].id as string;
    } catch (e) {
      throw mapSpendError(e);
    }
  }

  private async fetch(tx: pg.PoolClient, tenantId: string, id: string): Promise<SpendDto> {
    const r = await tx.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE s.tenant_id = $1 AND s.id = $2`, [tenantId, id]);
    if (!r.rows[0]) throw Errors.notFound('Spend entry');
    return toDto(r.rows[0]);
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────

const isIsoDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

function assertPeriod(from: string, to: string) {
  if (!isIsoDate(from) || !isIsoDate(to)) throw Errors.validation([{ path: 'body.periodStart', message: 'Dates must look like 2026-10-14' }]);
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (days < 0) throw Errors.validation([{ path: 'body.periodEnd', message: 'The end date must not be before the start date' }]);
  if (days > 366) throw Errors.validation([{ path: 'body.periodEnd', message: 'One entry can cover at most a year. Split longer periods.' }]);
}

function parseAmount(v: string): number | null {
  const t = v.replace(/(?:INR|USD|AED|EUR|GBP|Rs\.?|₹|\$|€|£)/gi, '').replace(/[,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  return n < 1e12 ? n : null;
}

function matchSource(v: string): SourceKey | null {
  const k = v.trim().toLowerCase().replace(/[^a-z]/g, '');
  if (!k) return null;
  const aliases: Record<string, SourceKey> = { meta: 'meta_ads', facebook: 'meta_ads', instagram: 'meta_ads', metaads: 'meta_ads', facebookads: 'meta_ads', google: 'google_ads', googleads: 'google_ads', adwords: 'google_ads', walkin: 'walk_in', propertyportal: 'portal', portals: 'portal' };
  if (aliases[k]) return aliases[k]!;
  const hit = LEAD_SOURCE_KEYS.find((s) => s !== 'other' && (s.replace(/[^a-z]/g, '') === k || SOURCE_LABEL[s].toLowerCase().replace(/[^a-z]/g, '') === k));
  return hit ?? null;
}

async function workspaceCurrency(tx: pg.PoolClient, tenantId: string): Promise<string> {
  const s = (await tx.query(`SELECT settings->>'currency' AS c FROM tenants WHERE id = $1`, [tenantId])).rows[0]?.c as string | undefined;
  return s && /^[A-Z]{3}$/.test(s) ? s : 'INR';
}

/** Serialises spend writes for one source, so two people entering overlapping periods cannot both pass the overlap check. */
async function lockSource(tx: pg.PoolClient, tenantId: string, source: string) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`spend:${tenantId}:${source}`]);
}

async function assertNoOverlap(tx: pg.PoolClient, tenantId: string, source: string, campaign: string | null, start: string, end: string, exceptId: string | null, row?: number) {
  const r = await tx.query(
    `SELECT to_char(period_start, 'YYYY-MM-DD') AS ps, to_char(period_end, 'YYYY-MM-DD') AS pe FROM marketing_spend
      WHERE tenant_id = $1 AND source = $2::lead_source AND lower(coalesce(campaign, '')) = lower($3) AND period_start <= $5::date AND period_end >= $4::date AND ($6::uuid IS NULL OR id <> $6::uuid) LIMIT 1`,
    [tenantId, source, campaign ?? '', start, end, exceptId]
  );
  if (r.rows[0]) {
    throw Errors.conflict(`${row ? `Row ${row}: ` : ''}There is already spend entered for ${sourceLabel(source)}${campaign ? ` · ${campaign}` : ''} from ${r.rows[0].ps} to ${r.rows[0].pe}. Edit that entry instead of adding one that overlaps it.`, { extensions: { reason: 'spend_overlaps' } });
  }
}

function mapSpendError(e: unknown): unknown {
  if ((e as { code?: string })?.code === '23505') return Errors.conflict('There is already spend entered for this source, campaign and period. Edit that entry instead.', { extensions: { reason: 'spend_overlaps' } });
  return e;
}
