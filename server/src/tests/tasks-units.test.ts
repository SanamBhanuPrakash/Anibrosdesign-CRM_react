import { describe, it, expect } from 'vitest';
import { addInZone, isValidTimeZone, nextOccurrence, startOfDayInZone } from '../modules/tasks/recurrence';

describe('recurrence in the workspace time zone', () => {
  it('keeps the wall-clock time across a daylight-saving change', () => {
    // New York springs forward on Sun 8 Mar 2026: 10:00 EST (15:00Z) → next day 10:00 EDT (14:00Z), not 11:00.
    const d = addInZone(new Date('2026-03-07T15:00:00Z'), 'America/New_York', 'daily', 1);
    expect(d.toISOString()).toBe('2026-03-08T14:00:00.000Z');
    // …and back in November (fall back on 1 Nov 2026): 10:00 EDT (14:00Z) → 10:00 EST (15:00Z)
    expect(addInZone(new Date('2026-10-31T14:00:00Z'), 'America/New_York', 'daily', 1).toISOString()).toBe('2026-11-01T15:00:00.000Z');
  });
  it('weekly stays on the same weekday and hour', () => {
    expect(addInZone(new Date('2026-03-04T15:00:00Z'), 'America/New_York', 'weekly', 1).toISOString()).toBe('2026-03-11T14:00:00.000Z');
  });
  it('monthly clamps to the end of shorter months and recovers afterwards', () => {
    const jan31 = new Date('2026-01-31T04:30:00Z'); // 10:00 in Kolkata
    const feb = addInZone(jan31, 'Asia/Kolkata', 'monthly', 1);
    expect(feb.toISOString()).toBe('2026-02-28T04:30:00.000Z');
    expect(addInZone(new Date('2026-02-28T04:30:00Z'), 'Asia/Kolkata', 'monthly', 1).toISOString()).toBe('2026-03-28T04:30:00.000Z');
    expect(addInZone(new Date('2028-01-31T04:30:00Z'), 'Asia/Kolkata', 'monthly', 1).toISOString()).toBe('2028-02-29T04:30:00.000Z'); // leap year
    expect(addInZone(jan31, 'Asia/Kolkata', 'monthly', 12).toISOString()).toBe('2027-01-31T04:30:00.000Z');
  });
  it('a late completion does not create a backlog: the next due date is the first slot in the future', () => {
    const now = new Date('2026-10-14T06:00:00Z');
    const next = nextOccurrence(new Date('2026-10-01T04:30:00Z'), { freq: 'daily', interval: 1 }, 'Asia/Kolkata', now);
    expect(next.toISOString()).toBe('2026-10-14T04:30:00.000Z'.replace('14T04', '15T04'));
    const weekly = nextOccurrence(new Date('2026-09-01T04:30:00Z'), { freq: 'weekly', interval: 2 }, 'Asia/Kolkata', now);
    expect(weekly.getTime()).toBeGreaterThan(now.getTime());
    expect(weekly.getTime() - now.getTime()).toBeLessThanOrEqual(14 * 86_400_000);
  });
  it('finds the local day boundaries and validates zone names', () => {
    expect(startOfDayInZone(new Date('2026-10-14T20:00:00Z'), 'Asia/Kolkata').toISOString()).toBe('2026-10-14T18:30:00.000Z'); // 15 Oct 00:30 IST is the next day's start… 14 Oct 00:00 IST = 13 Oct 18:30Z
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});
