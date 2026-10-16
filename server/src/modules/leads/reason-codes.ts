/**
 * Reason codes for closing a lead without a sale (decision D4).
 *
 *   Lost       the buyer was real but did not buy from us
 *   Not a fit  there was never a buyer to win (spam, wrong number, duplicate, not a buyer)
 *
 * Codes are stable identifiers stored on the lead and on its history; labels may be reworded without touching data.
 * "other" always needs a written note. A pipeline can make a code mandatory (`pipelines.reason_codes_required`, on for the
 * recommended pipeline); pipelines created earlier keep their original rule (a written reason).
 */
export type ReasonKind = 'lost' | 'not_a_fit';

export interface ReasonCode {
  code: string;
  label: string;
}

export const REASON_CODES: Record<ReasonKind, ReasonCode[]> = {
  lost: [
    { code: 'bought_elsewhere', label: 'Bought elsewhere' },
    { code: 'price_too_high', label: 'Price too high' },
    { code: 'financing', label: 'Could not get financing' },
    { code: 'timing', label: 'Timing did not work' },
    { code: 'changed_mind', label: 'Changed their mind' },
    { code: 'no_response', label: 'Stopped responding' },
    { code: 'other', label: 'Other (explain)' },
  ],
  not_a_fit: [
    { code: 'spam', label: 'Spam or junk' },
    { code: 'wrong_number', label: 'Wrong number or unreachable' },
    { code: 'duplicate', label: 'Duplicate of another lead' },
    { code: 'not_a_buyer', label: 'Not a buyer (agent, vendor, job seeker)' },
    { code: 'test', label: 'Test enquiry' },
    { code: 'other', label: 'Other (explain)' },
  ],
};

/** Which catalogue a lifecycle status closes into, if any. */
export const reasonKindOf = (status: string): ReasonKind | null => (status === 'lost' ? 'lost' : status === 'disqualified' ? 'not_a_fit' : null);

export const findReason = (kind: ReasonKind, code: string): ReasonCode | undefined => REASON_CODES[kind].find((r) => r.code === code);

/** Label for a stored code in either catalogue ("Unspecified" for legacy rows that never had one). */
export function reasonLabel(code: string | null | undefined): string {
  if (!code) return 'No reason recorded';
  return findReason('lost', code)?.label ?? findReason('not_a_fit', code)?.label ?? code.replace(/_/g, ' ');
}
