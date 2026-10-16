import crypto from 'crypto';
import { safeEqual } from '../../platform/crypto/field-encryption';

/**
 * Provider-specific knowledge for inbound lead sources, kept as pure functions (no I/O) so every rule is unit-tested.
 *
 *   verify*()          proves the sender (constant-time comparisons, replay window for signed timestamps)
 *   extractEvents()    turns one HTTP delivery into 0..n durable events (Meta batches several leads in one call)
 *   normalizeLead()    turns a stored event into the data the lead service needs, plus provenance and the free-form answers
 *
 * Nothing here trusts the payload: every string is trimmed, stripped of control characters and length-capped.
 */

export const PROVIDERS = ['meta', 'google', 'website', 'generic'] as const;
export type InboundProvider = (typeof PROVIDERS)[number];
export type InboundLeadSource = 'website' | 'referral' | 'portal' | 'direct' | 'meta_ads' | 'google_ads' | 'walk_in' | 'other';
export const SELECTABLE_SOURCES: InboundLeadSource[] = ['website', 'referral', 'portal', 'direct', 'meta_ads', 'google_ads', 'walk_in', 'other'];

/** Raised for a delivery that is authentic but cannot be understood. The receiver answers 400; nothing is stored. */
export class BadPayload extends Error {}

export interface ReceivedEvent {
  eventId: string;
  payload: Record<string, unknown>;
  isTest: boolean;
}

export interface NormalizedLead {
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  source: InboundLeadSource;
  campaign: string | null;
  budgetMax: number | null;
  bedroomsMin: number | null;
  locations: string[];
  tags: string[];
  /** Provenance saved on the lead (ids, click ids, utm …). */
  details: Record<string, unknown>;
  /** Answers that have no column of their own; shown on the lead timeline. */
  answers: Array<{ label: string; value: string }>;
  /** What the person wrote in the form's message box or to the chatbot (kept whole, shown as a note on the lead). */
  message: string | null;
  /** A chatbot conversation, oldest first. */
  conversation: Array<{ who: 'visitor' | 'bot'; text: string }>;
  isTest: boolean;
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────

/* eslint-disable-next-line no-control-regex */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
export const clean = (v: unknown, max = 500): string => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : Array.isArray(v) ? v.map((x) => clean(x, max)).filter(Boolean).join(', ') : '';
  return s.replace(CONTROL, '').replace(/\s+/g, ' ').trim().slice(0, max);
};
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hex = (b: Buffer) => b.toString('hex');
const hmac = (secret: string, data: string | Buffer) => hex(crypto.createHmac('sha256', secret).update(data).digest());

// ── signatures ───────────────────────────────────────────────────────────────────────────────────────────────

/** Meta signs the raw body with the app secret: `X-Hub-Signature-256: sha256=<hex>`. */
export function verifyMetaSignature(raw: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  return safeEqual(header.slice(7).toLowerCase(), hmac(appSecret, raw));
}

/** Signature for the generic JSON channel: `X-Anibros-Signature: t=<unix seconds>,v1=<hex>` over `${t}.${rawBody}`. */
export function signGeneric(raw: string | Buffer, secret: string, t: number): string {
  return `t=${t},v1=${hmac(secret, `${t}.${raw.toString()}`)}`;
}
export function verifyGenericSignature(raw: Buffer, header: string | undefined, secret: string, nowMs = Date.now(), toleranceSeconds = 300): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=') as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1) return false;
  if (Math.abs(nowMs / 1000 - t) > toleranceSeconds) return false; // replay window
  return safeEqual(parts.v1.toLowerCase(), hmac(secret, `${t}.${raw.toString()}`));
}

/** Google Ads lead-form webhooks carry the key you configured in the request body as `google_key`. */
export function verifyGoogleKey(body: Record<string, unknown>, key: string): boolean {
  return typeof body.google_key === 'string' && safeEqual(body.google_key, key);
}

// ── body parsing ─────────────────────────────────────────────────────────────────────────────────────────────

export function parseBody(raw: Buffer, contentType: string | undefined): Record<string, unknown> {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  const text = raw.toString('utf8');
  if (!text.trim()) throw new BadPayload('Empty body');
  if (type === 'application/x-www-form-urlencoded') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of new URLSearchParams(text)) if (k.length <= 100 && !(k in out)) out[k] = v;
    return out;
  }
  try {
    const j = JSON.parse(text);
    if (!isObject(j)) throw new BadPayload('Body must be a JSON object');
    return j;
  } catch (e) {
    if (e instanceof BadPayload) throw e;
    throw new BadPayload('Body is not valid JSON');
  }
}

// ── receipt: one delivery → events ─────────────────────────────────────────────────────────────────────────────

export function extractEvents(provider: InboundProvider, body: Record<string, unknown>, raw: Buffer, headers: Record<string, string | string[] | undefined>): ReceivedEvent[] {
  switch (provider) {
    case 'meta': {
      // { object: 'page', entry: [{ id, time, changes: [{ field: 'leadgen', value: { leadgen_id, page_id, form_id, ad_id, adgroup_id, created_time } }] }] }
      if (body.object !== 'page' || !Array.isArray(body.entry)) throw new BadPayload('Not a Meta page webhook');
      const out: ReceivedEvent[] = [];
      for (const entry of body.entry.slice(0, 50)) {
        if (!isObject(entry) || !Array.isArray(entry.changes)) continue;
        for (const ch of entry.changes.slice(0, 100)) {
          if (!isObject(ch) || ch.field !== 'leadgen' || !isObject(ch.value)) continue;
          const id = clean(ch.value.leadgen_id, 100);
          if (!id) continue;
          // `lead` may be present when a sender (or test) already includes the form answers; real deliveries only carry ids.
          out.push({ eventId: id, payload: { leadgen: ch.value, ...(isObject(ch.value.lead) ? { lead: ch.value.lead } : {}), pageId: clean(entry.id, 100) }, isTest: ch.value.is_test === true });
        }
      }
      return out; // an empty list is valid (Meta also sends non-lead changes to the same URL)
    }
    case 'google': {
      const id = clean(body.lead_id, 200);
      if (!id) throw new BadPayload('Missing lead_id');
      const { google_key: _drop, ...rest } = body; // never store the shared key
      void _drop;
      return [{ eventId: id, payload: rest, isTest: body.is_test === true }];
    }
    case 'website': {
      const { _hp: _h, website_url: _w, ...rest } = body;
      void _h;
      void _w;
      return [{ eventId: clean(body.eventId ?? body.event_id, 100) || crypto.randomUUID(), payload: rest, isTest: false }];
    }
    case 'generic': {
      const headerId = headers['x-event-id'];
      const id = clean(Array.isArray(headerId) ? headerId[0] : headerId, 100) || clean(body.eventId ?? body.event_id ?? body.id, 100) || crypto.createHash('sha256').update(raw).digest('hex');
      return [{ eventId: id, payload: body, isTest: body.is_test === true || body.isTest === true }];
    }
  }
}

/** Website forms carry a hidden trap field that humans never fill. */
export function honeypotTripped(body: Record<string, unknown>): boolean {
  return ['_hp', 'website_url'].some((k) => clean(body[k], 10).length > 0);
}

// ── normalisation ─────────────────────────────────────────────────────────────────────────────────────────────

const NAME_KEYS = ['full_name', 'fullname', 'name', 'your_name', 'contact_name', 'customer_name'];
const FIRST_KEYS = ['first_name', 'firstname', 'first', 'given_name'];
const LAST_KEYS = ['last_name', 'lastname', 'surname', 'family_name'];
const EMAIL_KEYS = ['email', 'email_address', 'work_email', 'e_mail', 'mail'];
const PHONE_KEYS = ['phone_number', 'phone', 'mobile', 'mobile_number', 'work_phone_number', 'whatsapp', 'whatsapp_number', 'contact_number', 'telephone', 'tel'];
const BUDGET_KEYS = ['budget', 'max_budget', 'budget_max', 'your_budget'];
const BEDROOM_KEYS = ['bedrooms', 'bhk', 'beds', 'bedroom', 'configuration', 'preferred_configuration'];
const LOCATION_KEYS = ['location', 'preferred_location', 'locality', 'city', 'area', 'preferred_area'];
const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** "85 lakh", "1.2 cr", "50,00,000", "₹ 75L" → rupees. Anything it cannot read confidently becomes null (kept as an answer). */
export function parseMoney(text: string): number | null {
  const t = text.toLowerCase().replace(/[,₹$\s]/g, '').replace(/^rs\.?/, '');
  const m = /^(\d+(?:\.\d+)?)(l|lac|lacs|lakh|lakhs|cr|crore|crores|k)?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  const mult = !m[2] ? 1 : m[2] === 'k' ? 1_000 : m[2].startsWith('c') ? 10_000_000 : 100_000;
  const v = n * mult;
  return Number.isFinite(v) && v > 0 && v < 1e13 ? v : null;
}

/** Flat key → value view of a submission, with the original label kept for display. */
type Field = { key: string; label: string; value: string };

function pretty(k: string): string {
  const s = k.replace(/[_-]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : k;
}

function toFields(entries: Array<[string, unknown]>): Field[] {
  const out: Field[] = [];
  for (const [rawKey, rawVal] of entries.slice(0, 80)) {
    const value = clean(rawVal, 2000);
    const key = norm(clean(rawKey, 100));
    if (key && value) out.push({ key, label: pretty(clean(rawKey, 100)), value });
  }
  return out;
}

const MESSAGE_KEYS = ['message', 'your_message', 'comments', 'comment', 'enquiry', 'inquiry', 'query', 'requirement', 'requirements', 'details', 'description', 'how_can_we_help', 'how_can_we_help_you', 'note', 'notes', 'question', 'text', 'msg', 'tell_us_more', 'project_details', 'brief', 'your_enquiry', 'your_requirement'];
const MESSAGE_LIKE = /(message|comment|enquir|inquir|requirement|question|how_can|help_you|details|brief|query|msg|tell_us|notes?$)/;
const NOT_A_NAME = /(company|business|organi[sz]ation|brand|project|property|file|user_?name|login|city|state|country|subject|page|form|campaign)/;
const NOT_A_PHONE = /(fax|pin|zip|postal|otp|code|id$|^id_)/;
const PHONE_LIKE = /(phone|mobile|whats_?app|contact_?(no|number|num)|(^|_)tel($|_)|(^|_)cell($|_)|(^|_)number$)/;
/** Where on the website it was sent from: kept with the lead, not listed as something the person answered. */
const CONTEXT_KEYS = ['page_url', 'page', 'page_title', 'referrer', 'form_name', 'form_id', 'form', 'anibros_form', 'chat_id', 'conversation_id'];
const NOT_BY_VALUE =/(budget|price|amount|salary|income|zip|pin|postal|year|age|date|id$|^id_|utm_|gclid|fbclid|otp|code)/;
const PHONE_VALUE =/^\+?[\d\s().-]{7,22}$/;

const SPEAKER: Record<string, 'visitor' | 'bot'> = { visitor: 'visitor', user: 'visitor', customer: 'visitor', client: 'visitor', human: 'visitor', lead: 'visitor', contact: 'visitor', me: 'visitor', bot: 'bot', agent: 'bot', assistant: 'bot', operator: 'bot', ai: 'bot', system: 'bot', support: 'bot' };
const TURN_TEXT = ['text', 'message', 'content', 'body', 'msg', 'value'];
const TURN_WHO = ['from', 'role', 'sender', 'author', 'type', 'who', 'speaker'];

const CONVERSATION_KEYS = ['conversation', 'transcript', 'messages', 'chat', 'history', 'chat_history', 'chat_log'];

/** A chatbot transcript in any common shape: [{from:'visitor', text}], [{role:'user', content}], or plain strings (alternating from the visitor). */
export function readConversation(payload: Record<string, unknown>): NormalizedLead['conversation'] {
  const raw = CONVERSATION_KEYS.map((k) => payload[k]).find(Array.isArray) as unknown[] | undefined;
  if (!raw) return [];
  const out: NormalizedLead['conversation'] = [];
  raw.slice(0, 80).forEach((turn, i) => {
    if (typeof turn === 'string') {
      const text = clean(turn, 600);
      if (text) out.push({ who: i % 2 === 0 ? 'visitor' : 'bot', text });
      return;
    }
    if (!isObject(turn)) return;
    const text = clean(TURN_TEXT.map((k) => turn[k]).find((v) => typeof v === 'string' && v.trim()), 600);
    if (!text) return;
    const whoRaw = clean(TURN_WHO.map((k) => turn[k]).find((v) => typeof v === 'string'), 40).toLowerCase();
    out.push({ who: SPEAKER[whoRaw] ?? (turn.is_bot === true || turn.bot === true ? 'bot' : 'visitor'), text });
  });
  return out;
}

/** Nested objects (a chatbot's `visitor: { name, email }`) become one flat list, `visitor_name`, `visitor_email`. */
export function flatten(payload: Record<string, unknown>, skip: (k: string) => boolean = () => false): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  const walk = (obj: Record<string, unknown>, prefix: string, depth: number) => {
    for (const [k, v] of Object.entries(obj)) {
      if (out.length >= 120) return;
      if (!prefix && skip(k)) continue;
      const key = prefix ? `${prefix}_${k}` : k;
      if (isObject(v)) {
        if (depth < 3) walk(v, key, depth + 1);
      } else if (!Array.isArray(v) || v.every((x) => typeof x !== 'object')) out.push([key, v]);
    }
  };
  walk(payload, '', 0);
  return out;
}

function buildLead(fields: Field[], base: { source: InboundLeadSource; campaign: string | null; details: Record<string, unknown>; tags: string[]; isTest: boolean; conversation?: NormalizedLead['conversation'] }): NormalizedLead {
  const used = new Set<string>();
  const take = (keys: string[]): string | null => {
    for (const k of keys) {
      const f = fields.find((x) => x.key === k && !used.has(x.key));
      if (f) {
        used.add(f.key);
        return f.value;
      }
    }
    return null;
  };
  /** Websites name their fields in every way (your-name, e-mail, Contact No.): when the exact names miss, recognise them by pattern, then by what the value looks like. */
  const takeLike = (test: RegExp, opts: { avoid?: RegExp; value?: (v: string) => boolean; longest?: boolean } = {}): string | null => {
    const hits = fields.filter((x) => !used.has(x.key) && test.test(x.key) && !(opts.avoid && opts.avoid.test(x.key)) && (!opts.value || opts.value(x.value)));
    const f = opts.longest ? hits.sort((a, b) => b.value.length - a.value.length)[0] : hits[0];
    if (!f) return null;
    used.add(f.key);
    return f.value;
  };
  const takeByValue = (ok: (v: string) => boolean): string | null => {
    const f = fields.find((x) => !used.has(x.key) && !NOT_BY_VALUE.test(x.key) && ok(x.value));
    if (!f) return null;
    used.add(f.key);
    return f.value;
  };
  const digits = (v: string) => v.replace(/\D/g, '').length;
  const looksLikePhone = (v: string) => PHONE_VALUE.test(v) && digits(v) >= 7 && digits(v) <= 15;

  let first = take(FIRST_KEYS) ?? takeLike(/(^|_)(first|given|f)_?name($|_)|^fname$/);
  let last = take(LAST_KEYS) ?? takeLike(/(^|_)(last|sur|family|l)_?name($|_)|^lname$/);
  const full = take(NAME_KEYS) ?? takeLike(/(^|_)name($|_)/, { avoid: NOT_A_NAME });
  if (!first && full) {
    const parts = full.split(' ').filter(Boolean);
    first = parts[0] ?? null;
    last = last ?? (parts.slice(1).join(' ') || null);
  }
  const emailRaw = take(EMAIL_KEYS) ?? takeLike(/e_?mail/) ?? takeByValue((v) => EMAIL_RE.test(v));
  const email = emailRaw && EMAIL_RE.test(emailRaw) ? emailRaw.toLowerCase() : null;
  const phoneRaw = take(PHONE_KEYS) ?? takeLike(PHONE_LIKE, { avoid: NOT_A_PHONE }) ?? takeByValue(looksLikePhone);
  const phone = phoneRaw && phoneRaw.replace(/\D/g, '').length >= 7 ? phoneRaw : null;
  let message = take(MESSAGE_KEYS) ?? takeLike(MESSAGE_LIKE, { longest: true });
  if (!message && base.conversation?.length) {
    const said = base.conversation.filter((t) => t.who === 'visitor').map((t) => t.text).join(' / ');
    message = said ? said.slice(0, 1000) : null;
  }

  const answers: NormalizedLead['answers'] = [];
  if (emailRaw && !email) answers.push({ label: 'Email (as entered)', value: emailRaw });
  if (phoneRaw && !phone) answers.push({ label: 'Phone (as entered)', value: phoneRaw });

  let budgetMax: number | null = null;
  const budgetText = take(BUDGET_KEYS);
  if (budgetText) {
    budgetMax = parseMoney(budgetText);
    if (budgetMax === null) answers.push({ label: 'Budget', value: budgetText });
  }
  let bedroomsMin: number | null = null;
  const bedText = take(BEDROOM_KEYS);
  if (bedText) {
    const n = /(\d{1,2})/.exec(bedText);
    if (n && Number(n[1]) >= 1 && Number(n[1]) <= 20) bedroomsMin = Number(n[1]);
    else answers.push({ label: 'Configuration', value: bedText });
  }
  const locations: string[] = [];
  for (const k of LOCATION_KEYS) {
    const v = take([k]);
    if (v) locations.push(v.slice(0, 100));
  }

  for (const f of fields) if (!used.has(f.key) && !f.key.startsWith('utm_') && !CONTEXT_KEYS.includes(f.key) && !['gclid', 'fbclid', 'message_consent'].includes(f.key)) answers.push({ label: f.label, value: f.value.slice(0, 500) });
  const utm: Record<string, string> = {};
  for (const f of fields) if (f.key.startsWith('utm_') || f.key === 'gclid' || f.key === 'fbclid') utm[f.key] = f.value.slice(0, 200);
  const where: Record<string, string> = {};
  for (const f of fields) if (CONTEXT_KEYS.includes(f.key)) where[f.key] = f.value.slice(0, 300);

  return {
    firstName: (first ?? (email ? email.split('@')[0] : phone ?? 'Unknown')).slice(0, 100),
    lastName: last ? last.slice(0, 100) : null,
    email,
    phone,
    source: base.source,
    campaign: base.campaign,
    budgetMax,
    bedroomsMin,
    locations,
    tags: base.tags,
    details: { ...base.details, ...(Object.keys(utm).length ? { tracking: utm } : {}), ...(Object.keys(where).length ? { context: where } : {}), ...(answers.length ? { answers: answers.slice(0, 40) } : {}) },
    answers: answers.slice(0, 40),
    message,
    conversation: base.conversation ?? [],
    isTest: base.isTest,
  };
}

export interface EndpointConfig {
  source?: InboundLeadSource;
  campaign?: string;
  tags?: string[];
  pipelineId?: string;
  stageId?: string;
  ownerId?: string | null;
  allowedOrigins?: string[];
  /** generic channel: map your field names to ours, e.g. { "mobile_no": "phone" } */
  fieldMap?: Record<string, string>;
}

const withTest = (tags: string[], isTest: boolean) => (isTest ? [...new Set([...tags, 'test'])] : tags);

export function normalizeLead(provider: InboundProvider, payload: Record<string, unknown>, cfg: EndpointConfig, isTest: boolean, endpointId: string): NormalizedLead {
  const baseTags = withTest((cfg.tags ?? []).map((t) => clean(t, 40)).filter(Boolean), isTest);
  switch (provider) {
    case 'meta': {
      const lead = isObject(payload.lead) ? payload.lead : null;
      if (!lead) throw new BadPayload('Meta lead details are missing');
      const fd = Array.isArray(lead.field_data) ? lead.field_data : [];
      const fields = toFields(fd.filter(isObject).map((f) => [clean(f.name, 100), f.values] as [string, unknown]));
      const lg = isObject(payload.leadgen) ? payload.leadgen : {};
      const campaignName = clean(lead.campaign_name, 150) || null;
      return buildLead(fields, {
        source: 'meta_ads',
        campaign: cfg.campaign ?? campaignName,
        tags: baseTags,
        isTest,
        details: {
          provider: 'meta', endpointId, leadgenId: clean(lg.leadgen_id ?? lead.id, 100), pageId: clean(payload.pageId ?? lg.page_id, 100), formId: clean(lead.form_id ?? lg.form_id, 100),
          campaignId: clean(lead.campaign_id, 100), campaignName, adsetId: clean(lead.adset_id ?? lg.adgroup_id, 100), adsetName: clean(lead.adset_name, 150),
          adId: clean(lead.ad_id ?? lg.ad_id, 100), adName: clean(lead.ad_name, 150), platform: clean(lead.platform, 30) || undefined, organic: lead.is_organic === true ? true : undefined,
          createdTime: clean(lead.created_time ?? lg.created_time, 40) || undefined,
        },
      });
    }
    case 'google': {
      const cols = Array.isArray(payload.user_column_data) ? payload.user_column_data : [];
      const fields = toFields(cols.filter(isObject).map((c) => [clean(c.column_id ?? c.column_name, 100), c.string_value] as [string, unknown]));
      return buildLead(fields, {
        source: 'google_ads',
        campaign: cfg.campaign ?? (clean(payload.campaign_name, 150) || (payload.campaign_id ? `Google campaign ${clean(payload.campaign_id, 50)}` : null)),
        tags: baseTags,
        isTest,
        details: {
          provider: 'google', endpointId, leadId: clean(payload.lead_id, 200), formId: clean(payload.form_id, 100), campaignId: clean(payload.campaign_id, 100),
          adgroupId: clean(payload.adgroup_id, 100), creativeId: clean(payload.creative_id, 100), gclid: clean(payload.gcl_id ?? payload.gclid, 200) || undefined, apiVersion: clean(payload.api_version, 20) || undefined,
        },
      });
    }
    case 'website': {
      const fields = toFields(flatten(payload, (k) => ['eventId', 'event_id', ...CONVERSATION_KEYS].includes(k)));
      return buildLead(fields, { source: cfg.source ?? 'website', campaign: cfg.campaign ?? (clean(payload.utm_campaign, 150) || null), tags: baseTags, isTest, conversation: readConversation(payload), details: { provider: 'website', endpointId, page: clean(payload.page_url ?? payload.page, 300) || undefined } });
    }
    case 'generic': {
      const map = cfg.fieldMap ?? {};
      const entries = flatten(payload, (k) => ['id', 'eventId', 'event_id', 'is_test', 'isTest', ...CONVERSATION_KEYS].includes(k)).map(([k, v]) => [map[k] ?? k, v] as [string, unknown]);
      return buildLead(toFields(entries), { source: cfg.source ?? 'other', campaign: cfg.campaign ?? (clean(payload.campaign, 150) || null), tags: baseTags, isTest, conversation: readConversation(payload), details: { provider: 'generic', endpointId } });
    }
  }
}

/** A short, PII-light line for the delivery log (never the full payload). */
export function summarize(provider: InboundProvider, payload: Record<string, unknown>): string {
  try {
    const n = normalizeLead(provider, payload, {}, false, '-');
    return [n.firstName, n.lastName].filter(Boolean).join(' ');
  } catch {
    return '';
  }
}
