import type pg from 'pg';
import { Errors } from '../../platform/errors';

/**
 * Whole local days in the WORKSPACE time zone, shared by the Dashboard, Attribution and Reports so every number and the list behind it
 * use the same boundaries (a daylight-saving day is 23 or 25 hours long, never assumed to be 24).
 */
export interface RangeQuery {
  from?: string;
  to?: string;
}
export interface Range {
  from: string;
  to: string;
  timezone: string;
  days: number;
  start: Date;
  end: Date;
  currency: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 366;

/** Whole local days in the workspace time zone: [from 00:00, to + 1 day 00:00). Defaults to the last 30 days including today. */
export async function resolveRange(tx: pg.PoolClient, tenantId: string, q: RangeQuery): Promise<Range> {
  const t = (await tx.query(`SELECT timezone, settings FROM tenants WHERE id = $1`, [tenantId])).rows[0];
  const timezone = (t?.timezone as string | undefined) || 'UTC';
  const currency = typeof t?.settings?.currency === 'string' ? (t.settings.currency as string) : 'INR';
  for (const [k, v] of [['from', q.from], ['to', q.to]] as const) {
    if (v !== undefined && (!ISO_DATE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)))) throw Errors.validation([{ path: `query.${k}`, message: 'Use a date like 2026-10-14' }]);
  }
  const today = (await tx.query(`SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') AS d`, [timezone])).rows[0].d as string;
  const to = q.to ?? today;
  const from = q.from ?? ((await tx.query(`SELECT to_char($1::date - 29, 'YYYY-MM-DD') AS d`, [to])).rows[0].d as string);
  const r = (
    await tx.query(
      `SELECT (($1::date)::timestamp AT TIME ZONE $3) AS s, ((($2::date) + 1)::timestamp AT TIME ZONE $3) AS e, ($2::date - $1::date + 1) AS days`,
      [from, to, timezone]
    )
  ).rows[0];
  const days = Number(r.days);
  if (days < 1) throw Errors.validation([{ path: 'query.to', message: 'The end date must not be before the start date' }]);
  if (days > MAX_DAYS) throw Errors.validation([{ path: 'query.to', message: `Choose a range of at most ${MAX_DAYS} days` }]);
  return { from, to, timezone, days, start: r.s as Date, end: r.e as Date, currency };
}
