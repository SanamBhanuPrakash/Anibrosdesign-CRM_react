/**
 * Explainable lead scoring (0–100). Rule-based on purpose: a sales manager can read why a lead scores 62 and argue
 * with it, which a black box would not allow. Every point comes from a named factor and is stored with the lead
 * (`score_breakdown`) so the UI can show it.
 *
 *   contactability  can we reach them                           up to 15
 *   intent          budget / requirements captured              up to 20
 *   source          how well this channel converts              up to 15
 *   progress        how far down the pipeline (stage odds)      up to 30
 *   engagement      recent touch                                 up to 15
 *   staleness       open and ignored                              −10 / −20
 * Closed leads are fixed: won = 100, lost / disqualified = 0.
 */
export interface ScoreInput {
  status: string;
  stageProbability: number;
  source: string;
  hasPhone: boolean;
  hasEmail: boolean;
  estimatedValue: number | null;
  budgetMax: number | null;
  hasRequirements: boolean;
  lastActivityAt: Date | null;
  createdAt: Date;
}

export interface ScoreFactor {
  factor: string;
  points: number;
  note: string;
}

export interface ScoringConfig {
  /** Replace/extend per-source points (0–15). Unknown sources get `other`. */
  sourceWeights?: Record<string, number>;
}

export const DEFAULT_SOURCE_WEIGHTS: Record<string, number> = {
  referral: 15,
  walk_in: 15,
  direct: 10,
  website: 8,
  portal: 6,
  google_ads: 6,
  meta_ads: 4,
  other: 2,
};

const DAY = 86_400_000;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function computeLeadScore(input: ScoreInput, cfg: ScoringConfig = {}, now = new Date()): { score: number; factors: ScoreFactor[] } {
  if (input.status === 'won') return { score: 100, factors: [{ factor: 'outcome', points: 100, note: 'Won' }] };
  if (input.status === 'lost' || input.status === 'disqualified') return { score: 0, factors: [{ factor: 'outcome', points: 0, note: input.status === 'lost' ? 'Lost' : 'Disqualified' }] };

  const factors: ScoreFactor[] = [];
  const add = (factor: string, points: number, note: string) => {
    if (points !== 0) factors.push({ factor, points, note });
  };

  add('contactability', (input.hasPhone ? 10 : 0) + (input.hasEmail ? 5 : 0), [input.hasPhone && 'phone', input.hasEmail && 'email'].filter(Boolean).join(' + ') || 'no way to reach them yet');
  const intent = (input.budgetMax ? 10 : 0) + (input.hasRequirements ? 5 : 0) + (input.estimatedValue ? 5 : 0);
  add('intent', intent, [input.budgetMax && 'budget', input.hasRequirements && 'requirements', input.estimatedValue && 'deal value'].filter(Boolean).join(' + ') || 'nothing captured yet');

  const weights = { ...DEFAULT_SOURCE_WEIGHTS, ...(cfg.sourceWeights ?? {}) };
  add('source', clamp(Math.round(weights[input.source] ?? weights.other ?? 2), 0, 15), `via ${input.source.replace(/_/g, ' ')}`);
  add('progress', Math.round(clamp(input.stageProbability, 0, 100) * 0.3), `stage odds ${input.stageProbability}%`);

  const idleDays = (now.getTime() - (input.lastActivityAt ?? input.createdAt).getTime()) / DAY;
  if (input.lastActivityAt && idleDays <= 3) add('engagement', 15, 'touched in the last 3 days');
  else if (input.lastActivityAt && idleDays <= 14) add('engagement', 8, 'touched in the last 2 weeks');
  if (idleDays > 30) add('staleness', -20, `no activity for ${Math.floor(idleDays)} days`);
  else if (idleDays > 14) add('staleness', -10, `no activity for ${Math.floor(idleDays)} days`);

  const score = clamp(factors.reduce((a, f) => a + f.points, 0), 0, 100);
  return { score, factors };
}
