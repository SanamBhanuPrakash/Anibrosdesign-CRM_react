/**
 * Fixed lists for buyer interest and deals. Stable codes are stored; labels are what people read and may be reworded.
 */
export const INTEREST_STATUSES = ['shortlisted', 'interested', 'rejected'] as const;
export type InterestStatus = (typeof INTEREST_STATUSES)[number];
export const INTEREST_SOURCES = ['manual', 'matching', 'viewing', 'offer'] as const;
export type InterestSource = (typeof INTEREST_SOURCES)[number];

/**
 * offered    an offer was made on a unit (the unit shows "under offer"; several buyers may offer)
 * reserved   token paid, the unit is held for exactly one buyer (the unit shows "reserved"). A milestone, NOT revenue (decision D3).
 * completed  the sale/rental: a recorded deal value tied to the unit. The only state that counts as won deal value.
 * closed     ended without a sale (withdrawn, rejected, expired …) or a completed deal that was reversed
 */
export const RESERVATION_STATUSES = ['offered', 'reserved', 'completed', 'closed'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
export const OPEN_RESERVATION_STATUSES: ReservationStatus[] = ['offered', 'reserved'];

/** Why a deal attempt ended. `unit_taken` and `deal_reversed` are set by the system, never chosen. */
export const CLOSE_REASONS = [
  { code: 'buyer_withdrew', label: 'The buyer withdrew' },
  { code: 'offer_rejected', label: 'The offer was not accepted' },
  { code: 'price_not_agreed', label: 'Price could not be agreed' },
  { code: 'financing_failed', label: 'Financing fell through' },
  { code: 'chose_other_unit', label: 'The buyer chose another unit' },
  { code: 'hold_expired', label: 'The hold ran out' },
  { code: 'other', label: 'Other (say why)' },
] as const;
const SYSTEM_REASONS = [
  { code: 'unit_taken', label: 'The unit went to another buyer' },
  { code: 'deal_reversed', label: 'The sale was reversed' },
] as const;
export const CHOOSABLE_CLOSE_CODES = CLOSE_REASONS.map((r) => r.code) as [string, ...string[]];
export const closeReasonLabel = (code: string | null): string | null => [...CLOSE_REASONS, ...SYSTEM_REASONS].find((r) => r.code === code)?.label ?? null;
