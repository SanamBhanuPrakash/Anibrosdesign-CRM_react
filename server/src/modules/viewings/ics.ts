/**
 * iCalendar (RFC 5545) export of one viewing, for Apple / Google / Outlook calendars.
 *
 * What goes in: when, where, which property and the buyer's NAME. What stays out: the buyer's phone and e-mail address. A calendar
 * file is forwarded and synced to other people's devices, so it carries no more personal data than the appointment itself needs.
 * All text is escaped and lines are folded, so a note containing line breaks or iCalendar syntax can never inject properties.
 */
export interface IcsViewing {
  id: string;
  scheduledAt: Date | string;
  durationMinutes: number;
  status: string;
  notes: string | null;
  propertyTitle: string;
  propertyLocation: string | null;
  buyerName: string | null;
  agentName: string | null;
  publicUrl?: string;
  updatedAt?: Date | string;
  version?: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
export function icsDate(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** TEXT value escaping per RFC 5545 §3.3.11, plus removal of control characters. */
export function icsEscape(s: string): string {
  // control characters are removed on purpose: they have no place in a calendar text value
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Fold a content line at 75 octets (RFC 5545 §3.1) without splitting a multi-byte character. */
export function icsFold(line: string): string {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch, 'utf8');
    const limit = out.length === 0 ? 75 : 74; // continuation lines start with a space
    if (bytes + b > limit) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const STATUS: Record<string, string> = { scheduled: 'TENTATIVE', confirmed: 'CONFIRMED', completed: 'CONFIRMED', no_show: 'CONFIRMED', cancelled: 'CANCELLED' };

export function buildIcs(v: IcsViewing, now = new Date()): string {
  const start = new Date(v.scheduledAt);
  const end = new Date(start.getTime() + v.durationMinutes * 60_000);
  const summary = `Site visit: ${v.propertyTitle}`;
  const description = [v.buyerName ? `Buyer: ${v.buyerName}` : null, v.agentName ? `Agent: ${v.agentName}` : null, v.notes ? `Notes: ${v.notes}` : null, v.publicUrl ?? null].filter(Boolean).join('\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Anibros CRM//Viewings//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:viewing-${v.id}@anibros.crm`,
    `DTSTAMP:${icsDate(now)}`,
    `LAST-MODIFIED:${icsDate(new Date(v.updatedAt ?? now))}`,
    `SEQUENCE:${Math.max(0, (v.version ?? 1) - 1)}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsEscape(summary)}`,
    ...(v.propertyLocation ? [`LOCATION:${icsEscape(v.propertyLocation)}`] : []),
    ...(description ? [`DESCRIPTION:${icsEscape(description)}`] : []),
    `STATUS:${STATUS[v.status] ?? 'TENTATIVE'}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsEscape(summary)}`,
    'TRIGGER:-PT1H',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(icsFold).join('\r\n') + '\r\n';
}
