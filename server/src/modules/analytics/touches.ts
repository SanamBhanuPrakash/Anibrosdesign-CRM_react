import type pg from 'pg';

/**
 * Touches: where a lead came from, as it was at the time. The first touch of a lead is written when the lead is created and can never be
 * edited (database trigger); a later enquiry from someone who already has an open lead is appended as a later touch. "Last touch" is simply
 * the newest row. Editing a lead's source afterwards changes the lead, not its history.
 */
export interface TouchInput {
  source: string;
  campaign?: string | null;
  medium?: string | null;
  adGroup?: string | null;
  keyword?: string | null;
  clickId?: string | null;
  utmContent?: string | null;
}

const clip = (v: unknown, n: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Reads what a touch can carry out of the provenance that intake channels already record (utm tags, ad group, click ids). */
export function touchFrom(input: { source: string; campaign?: string | null; sourceDetails?: Record<string, unknown> | null }): TouchInput {
  const d = obj(input.sourceDetails);
  const tracking = obj(d.tracking);
  return {
    source: input.source,
    campaign: clip(input.campaign, 200),
    medium: clip(tracking.utm_medium, 100),
    adGroup: clip(d.adgroupId ?? d.adsetId, 200),
    keyword: clip(tracking.utm_term, 200),
    clickId: clip(d.gclid ?? tracking.gclid ?? tracking.fbclid, 300),
    utmContent: clip(tracking.utm_content, 200),
  };
}

async function insertTouch(tx: pg.PoolClient, tenantId: string, leadId: string, type: 'first_touch' | 'later_touch', t: TouchInput) {
  await tx.query(
    `INSERT INTO marketing_attribution (tenant_id, lead_id, touch_type, source, campaign, medium, ad_group, keyword, click_id, utm_content, is_direct)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
    [tenantId, leadId, type, t.source, t.campaign ?? null, t.medium ?? null, t.adGroup ?? null, t.keyword ?? null, t.clickId ?? null, t.utmContent ?? null, t.source === 'direct']
  );
}

/** Called by lead creation, inside its transaction. Writing twice is harmless (the unique index keeps the first). */
export const recordFirstTouch = (tx: pg.PoolClient, tenantId: string, leadId: string, t: TouchInput) => insertTouch(tx, tenantId, leadId, 'first_touch', t);
/** Called when a person who already has an open lead enquires again. */
export const recordLaterTouch = (tx: pg.PoolClient, tenantId: string, leadId: string, t: TouchInput) => insertTouch(tx, tenantId, leadId, 'later_touch', t);
