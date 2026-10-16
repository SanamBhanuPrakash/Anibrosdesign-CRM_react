/**
 * Recurring tasks, in the workspace's time zone.
 *
 * "Every day at 10:00" must stay 10:00 on the wall clock across a daylight-saving change, so the arithmetic is done
 * on local calendar fields and converted back to an instant — not by adding 86 400 000 ms. Months clamp to the last
 * day ("monthly" from 31 Jan is 28/29 Feb, then 31 Mar again, never 3 Mar).
 */
export interface Recurrence {
  freq: 'daily' | 'weekly' | 'monthly';
  interval: number;
}

interface Local {
  y: number;
  mo: number; // 1–12
  d: number;
  h: number;
  mi: number;
  s: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    fmt(tz);
    return true;
  } catch {
    return false;
  }
}

function toLocal(instant: Date, tz: string): Local {
  const p = Object.fromEntries(fmt(tz).formatToParts(instant).map((x) => [x.type, Number(x.value)])) as Record<string, number>;
  return { y: p.year!, mo: p.month!, d: p.day!, h: p.hour!, mi: p.minute!, s: p.second! };
}

const asUtcMs = (l: Local) => Date.UTC(l.y, l.mo - 1, l.d, l.h, l.mi, l.s);

/** Local wall-clock → instant. Two passes settle the offset even right next to a DST jump. */
function toInstant(l: Local, tz: string): Date {
  let guess = asUtcMs(l);
  for (let i = 0; i < 3; i++) {
    const seen = asUtcMs(toLocal(new Date(guess), tz));
    const delta = asUtcMs(l) - seen;
    if (delta === 0) break;
    guess += delta;
  }
  return new Date(guess);
}

/** 00:00 of the local day containing `instant`. */
export function startOfDayInZone(instant: Date, tz: string): Date {
  return toInstant({ ...toLocal(instant, tz), h: 0, mi: 0, s: 0 }, tz);
}

const daysInMonth =(y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

export function addInZone(instant: Date, tz: string, unit: Recurrence['freq'], n: number): Date {
  const l = toLocal(instant, tz);
  if (unit === 'monthly') {
    const total = l.y * 12 + (l.mo - 1) + n;
    const y = Math.floor(total / 12);
    const mo = (total % 12) + 1;
    return toInstant({ ...l, y, mo, d: Math.min(l.d, daysInMonth(y, mo)) }, tz);
  }
  const shifted = new Date(Date.UTC(l.y, l.mo - 1, l.d + (unit === 'weekly' ? 7 * n : n), l.h, l.mi, l.s));
  return toInstant({ y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth() + 1, d: shifted.getUTCDate(), h: l.h, mi: l.mi, s: l.s }, tz);
}

/**
 * The due date of the occurrence that follows `due`. A task completed late does not create a backlog of
 * already-missed occurrences: the next one is the first slot that is still in the future.
 */
export function nextOccurrence(due: Date, rule: Recurrence, tz: string, now = new Date()): Date {
  let next = addInZone(due, tz, rule.freq, rule.interval);
  for (let i = 0; i < 400 && next.getTime() <= now.getTime(); i++) next = addInZone(next, tz, rule.freq, rule.interval);
  return next;
}
