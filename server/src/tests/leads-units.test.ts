import { describe, it, expect } from 'vitest';
import { computeLeadScore, type ScoreInput } from '../modules/leads/scoring';
import { CsvError, csvCell, parseCsv, toCsv } from '../modules/leads/csv';
import { detectMapping } from '../modules/leads/import';
import { slaOf } from '../modules/leads/service';

const now = new Date('2026-10-14T10:00:00Z');
const base: ScoreInput = {
  status: 'open',
  stageProbability: 5,
  source: 'website',
  hasPhone: true,
  hasEmail: true,
  estimatedValue: null,
  budgetMax: null,
  hasRequirements: false,
  lastActivityAt: null,
  createdAt: now,
};

describe('lead scoring', () => {
  it('is explainable: every point belongs to a named factor and the factors add up', () => {
    const r = computeLeadScore({ ...base, budgetMax: 9_000_000, hasRequirements: true, estimatedValue: 8_500_000, source: 'referral', stageProbability: 45, lastActivityAt: new Date(now.getTime() - 86_400_000) }, {}, now);
    expect(r.factors.map((f) => f.factor)).toEqual(['contactability', 'intent', 'source', 'progress', 'engagement']);
    expect(r.score).toBe(r.factors.reduce((a, f) => a + f.points, 0));
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.factors.find((f) => f.factor === 'intent')!.points).toBe(20);
  });
  it('rewards reachability and a good source, and penalises neglect', () => {
    const fresh = computeLeadScore(base, {}, now).score;
    expect(computeLeadScore({ ...base, hasPhone: false, hasEmail: false }, {}, now).score).toBeLessThan(fresh);
    expect(computeLeadScore({ ...base, source: 'referral' }, {}, now).score).toBeGreaterThan(fresh);
    const stale = computeLeadScore({ ...base, createdAt: new Date(now.getTime() - 40 * 86_400_000) }, {}, now);
    expect(stale.factors.some((f) => f.factor === 'staleness' && f.points === -20)).toBe(true);
    expect(stale.score).toBeLessThan(fresh);
  });
  it('closed leads are fixed and the score never leaves 0–100', () => {
    expect(computeLeadScore({ ...base, status: 'won' }, {}, now).score).toBe(100);
    expect(computeLeadScore({ ...base, status: 'lost' }, {}, now).score).toBe(0);
    expect(computeLeadScore({ ...base, status: 'disqualified' }, {}, now).score).toBe(0);
    expect(computeLeadScore({ ...base, hasPhone: false, hasEmail: false, source: 'other', createdAt: new Date(now.getTime() - 90 * 86_400_000) }, {}, now).score).toBe(0);
  });
  it('lets a workspace re-weight sources', () => {
    const def = computeLeadScore({ ...base, source: 'meta_ads' }, {}, now).score;
    const tuned = computeLeadScore({ ...base, source: 'meta_ads' }, { sourceWeights: { meta_ads: 15 } }, now).score;
    expect(tuned - def).toBe(11);
  });
});

describe('csv', () => {
  it('parses quotes, embedded newlines, escaped quotes, CRLF and a BOM', () => {
    const p = parseCsv('﻿Name,Note\r\n"Rao, Asha","line1\nline2"\r\n"Say ""hi""",x\r\n');
    expect(p.header).toEqual(['Name', 'Note']);
    expect(p.rows).toEqual([['Rao, Asha', 'line1\nline2'], ['Say "hi"', 'x']]);
  });
  it('sniffs semicolon and tab delimiters and skips blank lines', () => {
    expect(parseCsv('a;b\n1;2\n\n3;4').rows).toEqual([['1', '2'], ['3', '4']]);
    expect(parseCsv('a\tb\n1\t2').rows).toEqual([['1', '2']]);
  });
  it('refuses broken or oversized files instead of guessing', () => {
    expect(() => parseCsv('a,b\n"unterminated,1')).toThrow(CsvError);
    expect(() => parseCsv('', {})).toThrow(CsvError);
    expect(() => parseCsv('a\n1\n2\n3', { maxRows: 2 })).toThrow(/Too many rows/);
    expect(() => parseCsv(Array.from({ length: 70 }, (_, i) => `c${i}`).join(',') + '\n1')).toThrow(/Too many columns/);
  });
  it('neutralises spreadsheet formulas on export but leaves real numbers alone', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    for (const s of ['+91 98450 12345', '-1+1', '@SUM(A1)', '\tcmd']) expect(csvCell(s).replace(/^"/, '').startsWith("'")).toBe(true);
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
    expect(csvCell(['a', 'b'])).toBe('a; b'.includes(';') ? '"a; b"' : 'a; b');
    expect(toCsv(['A'], [['x']])).toBe('﻿A\r\nx\r\n');
  });
});

describe('import column detection', () => {
  it('recognises common spreadsheet headers, each field once', () => {
    const m = detectMapping(['Customer Name', 'Mobile Number', 'E-mail', 'Lead Source', 'Budget', 'Preferred Location', 'Remarks', 'Campaign Name', 'Ignored']);
    expect(m).toEqual({
      'Customer Name': 'fullName',
      'Mobile Number': 'phone',
      'E-mail': 'email',
      'Lead Source': 'source',
      Budget: 'budgetMax',
      'Preferred Location': 'locations',
      Remarks: 'notes',
      'Campaign Name': 'campaign',
    });
    expect(Object.values(detectMapping(['name', 'Full Name'])).length).toBe(1);
  });
});

describe('first-response SLA state', () => {
  const created = new Date('2026-10-14T10:00:00Z');
  const due = new Date('2026-10-14T10:30:00Z');
  it('ok → at risk → breached, and met once answered', () => {
    expect(slaOf(due, null, false, created, new Date('2026-10-14T10:05:00Z')).state).toBe('ok');
    expect(slaOf(due, null, false, created, new Date('2026-10-14T10:24:00Z')).state).toBe('at_risk');
    expect(slaOf(due, null, false, created, new Date('2026-10-14T10:31:00Z')).state).toBe('breached');
    expect(slaOf(due, new Date('2026-10-14T10:10:00Z'), false, created, new Date('2026-10-14T12:00:00Z')).state).toBe('met');
    expect(slaOf(null, null, false, created).state).toBe('none');
    expect(slaOf(due, null, true, created, new Date('2026-10-14T12:00:00Z')).state).toBe('none');
  });
});
